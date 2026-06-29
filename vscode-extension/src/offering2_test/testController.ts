import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import * as yaml from 'js-yaml';
import * as vscode from 'vscode';
import { isRecord, ROOT_FILENAMES } from '../util/oc';
import { resolveCliCommand } from '../workspace/cliResolver';
import { scanCollection, type ScannedRequest } from '../workspace/collectionScanner';
import { resultKey, type CliRequestRunResult } from './cliResult';
import { classifyOutcome } from './outcome';
import { runViaShell, ShellRunError } from './shellRunner';

interface RequestMeta {
  collectionDir: string;
  folderPath: string[];
  name: string;
}

const DELIM = '::';

function leafId(collectionDir: string, folderPath: string[], name: string): string {
  return `${collectionDir}${DELIM}${[...folderPath, name].join('/')}`;
}

async function collectionLabel(rootDir: string): Promise<string> {
  for (const f of ROOT_FILENAMES) {
    try {
      const doc = yaml.load(await readFile(join(rootDir, f), 'utf8'), { schema: yaml.JSON_SCHEMA });
      if (isRecord(doc) && isRecord(doc.info) && typeof doc.info.name === 'string') {
        return doc.info.name;
      }
    } catch {
      // try next / fall through
    }
  }
  return basename(rootDir);
}

/**
 * Offering 2a — Test Explorer backed by the `restura` CLI (shell-out). Builds
 * the tree from a filesystem scan (so requests show without executing) and
 * attaches results by `folderPath + name`, which matches the CLI's
 * `LoadedRequest` shape.
 */
export function registerTestController(context: vscode.ExtensionContext): void {
  const controller = vscode.tests.createTestController('restura', 'Restura Collections');
  context.subscriptions.push(controller);

  const meta = new Map<string, RequestMeta>();

  const discover = async (): Promise<void> => {
    meta.clear();
    controller.items.replace([]);
    const rootFiles = await vscode.workspace.findFiles('**/opencollection.{yml,yaml}');
    const seen = new Set<string>();
    for (const rootUri of rootFiles) {
      const collectionDir = dirname(rootUri.fsPath);
      if (seen.has(collectionDir)) continue;
      seen.add(collectionDir);

      const requests = await scanCollection(collectionDir);
      if (requests.length === 0) continue;

      const label = await collectionLabel(collectionDir);
      const rootItem = controller.createTestItem(collectionDir, label, rootUri);
      controller.items.add(rootItem);
      for (const req of requests) addRequest(controller, rootItem, collectionDir, req, meta);
    }
  };

  controller.refreshHandler = discover;

  const runProfile = controller.createRunProfile(
    'Run',
    vscode.TestRunProfileKind.Run,
    (request, token) => runHandler(controller, meta, request, token),
    true
  );
  context.subscriptions.push(runProfile);

  context.subscriptions.push(
    vscode.commands.registerCommand('restura.refreshTests', () => discover())
  );

  // Re-discover when collection files change.
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.{yml,yaml}');
  let debounce: NodeJS.Timeout | undefined;
  const scheduleDiscover = (): void => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => void discover(), 500);
  };
  watcher.onDidCreate(scheduleDiscover);
  watcher.onDidDelete(scheduleDiscover);
  watcher.onDidChange(scheduleDiscover);
  context.subscriptions.push(watcher);

  void discover();
}

function addRequest(
  controller: vscode.TestController,
  rootItem: vscode.TestItem,
  collectionDir: string,
  req: ScannedRequest,
  meta: Map<string, RequestMeta>
): void {
  let parent = rootItem;
  const partial: string[] = [];
  for (const folder of req.folderPath) {
    partial.push(folder);
    const folderId = `${collectionDir}${DELIM}folder${DELIM}${partial.join('/')}`;
    let folderItem = parent.children.get(folderId);
    if (!folderItem) {
      folderItem = controller.createTestItem(folderId, folder);
      parent.children.add(folderItem);
    }
    parent = folderItem;
  }
  const id = leafId(collectionDir, req.folderPath, req.name);
  const item = controller.createTestItem(id, req.name, vscode.Uri.file(req.filePath));
  parent.children.add(item);
  meta.set(id, { collectionDir, folderPath: req.folderPath, name: req.name });
}

/** Gather the leaf TestItems implied by a run request (expanding folders). */
function gatherLeaves(
  request: vscode.TestRunRequest,
  controller: vscode.TestController,
  meta: Map<string, RequestMeta>
): vscode.TestItem[] {
  const excluded = new Set(request.exclude?.map((i) => i.id));
  const leaves: vscode.TestItem[] = [];
  const visit = (item: vscode.TestItem): void => {
    if (excluded.has(item.id)) return;
    if (meta.has(item.id)) {
      leaves.push(item);
      return;
    }
    item.children.forEach(visit);
  };
  if (request.include) {
    for (const item of request.include) visit(item);
  } else {
    controller.items.forEach(visit);
  }
  return leaves;
}

async function runHandler(
  controller: vscode.TestController,
  meta: Map<string, RequestMeta>,
  request: vscode.TestRunRequest,
  token: vscode.CancellationToken
): Promise<void> {
  const run = controller.createTestRun(request);
  const leaves = gatherLeaves(request, controller, meta);

  // Group by collection so each collection runs once.
  const byCollection = new Map<string, vscode.TestItem[]>();
  for (const leaf of leaves) {
    const m = meta.get(leaf.id);
    if (!m) continue;
    const group = byCollection.get(m.collectionDir) ?? [];
    group.push(leaf);
    byCollection.set(m.collectionDir, group);
  }

  for (const leaf of leaves) run.enqueued(leaf);

  const abort = new AbortController();
  token.onCancellationRequested(() => abort.abort());

  const config = vscode.workspace.getConfiguration('restura');
  const allowLocalhost = config.get<boolean>('allowLocalhost', true);
  const envFile = config.get<string>('env', '').trim();
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const cliCommand = resolveCliCommand(workspaceFolder);

  // Total leaves per collection, computed in one pass (vs re-scanning `meta`
  // for every collection in the loop below).
  const totals = new Map<string, number>();
  for (const m of meta.values())
    totals.set(m.collectionDir, (totals.get(m.collectionDir) ?? 0) + 1);

  try {
    for (const [collectionDir, groupLeaves] of byCollection) {
      if (token.isCancellationRequested) break;

      const runningSubset = groupLeaves.length < (totals.get(collectionDir) ?? 0);
      const include = runningSubset
        ? [...new Set(groupLeaves.map((l) => meta.get(l.id)!.name))]
        : undefined;

      for (const leaf of groupLeaves) run.started(leaf);

      let resultIndex: Map<string, CliRequestRunResult>;
      try {
        const result = await runViaShell({
          cliCommand,
          collectionDir,
          allowLocalhost,
          ...(include ? { include } : {}),
          ...(envFile ? { envFile } : {}),
          signal: abort.signal,
        });
        resultIndex = new Map(
          result.requests.map((r) => [resultKey(r.request.folderPath, r.request.request.name), r])
        );
      } catch (err) {
        const message = err instanceof ShellRunError ? err.message : String(err);
        for (const leaf of groupLeaves) run.errored(leaf, new vscode.TestMessage(message));
        continue;
      }

      for (const leaf of groupLeaves) {
        const m = meta.get(leaf.id)!;
        const r = resultIndex.get(resultKey(m.folderPath, m.name));
        if (!r) {
          run.skipped(leaf);
          continue;
        }
        applyResult(run, leaf, r);
      }
    }
  } finally {
    run.end();
  }
}

function applyResult(run: vscode.TestRun, leaf: vscode.TestItem, r: CliRequestRunResult): void {
  if (r.assertions && r.assertions.length > 0) {
    const lines = r.assertions.map(
      (a) => `${a.passed ? '✓' : '✗'} ${a.name}${a.error ? ` — ${a.error}` : ''}`
    );
    run.appendOutput(`${leaf.label}\r\n${lines.join('\r\n')}\r\n`);
  }

  const outcome = classifyOutcome(r);
  switch (outcome.kind) {
    case 'passed':
      run.passed(leaf, outcome.durationMs);
      return;
    case 'errored':
      run.errored(leaf, new vscode.TestMessage(outcome.message), outcome.durationMs);
      return;
    case 'failed':
      run.failed(leaf, new vscode.TestMessage(outcome.message), outcome.durationMs);
      return;
  }
}
