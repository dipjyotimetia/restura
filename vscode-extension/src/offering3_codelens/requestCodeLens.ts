import * as vscode from 'vscode';
import { formatAssertion, resultKey } from '../offering2_test/cliResult';
import { classifyOutcome } from '../offering2_test/outcome';
import { runViaShell, ShellRunError } from '../offering2_test/shellRunner';
import { getResturaSettings } from '../util/settings';
import { resolveCliCommand } from '../workspace/cliResolver';
import { classifyOcFile, REQUEST_CAPABILITIES } from '../workspace/collectionDetector';
import { findCollectionRoot } from '../workspace/collectionLocate';
import { scanCollection } from '../workspace/collectionScanner';
import { showError, showResponse } from './responsePanel';
import { sendRequest } from './sendInspect';

class RequestCodeLensProvider implements vscode.CodeLensProvider {
  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (document.uri.scheme !== 'file') return [];
    const classified = classifyOcFile(document.uri.fsPath, document.getText());
    if (classified.kind !== 'request') return [];

    const caps = REQUEST_CAPABILITIES[classified.type];
    const range = new vscode.Range(0, 0, 0, 0);
    const lenses: vscode.CodeLens[] = [];
    if (caps.sendable) {
      lenses.push(
        new vscode.CodeLens(range, {
          title: '$(play) Send',
          command: 'restura.sendRequest',
          arguments: [document.uri],
        })
      );
    }
    if (caps.runnableByCli) {
      lenses.push(
        new vscode.CodeLens(range, {
          title: '$(beaker) Run test',
          command: 'restura.runRequestAsTest',
          arguments: [document.uri],
        })
      );
    }
    return lenses;
  }
}

async function resolveTargetUri(arg: unknown): Promise<vscode.TextDocument | undefined> {
  if (arg instanceof vscode.Uri) return vscode.workspace.openTextDocument(arg);
  return vscode.window.activeTextEditor?.document;
}

function sendOptions(): { allowLocalhost: boolean; allowPrivateIPs: boolean } {
  const { allowLocalhost, allowPrivateIPs } = getResturaSettings();
  return { allowLocalhost, allowPrivateIPs };
}

export function registerCodeLens(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Restura');
  context.subscriptions.push(output);

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      { language: 'yaml', scheme: 'file' },
      new RequestCodeLensProvider()
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('restura.sendRequest', async (arg: unknown) => {
      const doc = await resolveTargetUri(arg);
      if (!doc) return;
      const classified = classifyOcFile(doc.uri.fsPath, doc.getText());
      const name = classified.kind === 'request' ? classified.name : doc.uri.fsPath;

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: `Restura: sending ${name}…` },
        async () => {
          const outcome = await sendRequest(doc.uri.fsPath, doc.getText(), sendOptions());
          if (outcome.ok) {
            showResponse(context, name, outcome.response, outcome.warnings, outcome.url);
          } else {
            showError(context, name, outcome.error, outcome.warnings);
          }
        }
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('restura.runRequestAsTest', async (arg: unknown) => {
      const doc = await resolveTargetUri(arg);
      if (!doc) return;
      const filePath = doc.uri.fsPath;
      const root = findCollectionRoot(filePath);
      if (!root) {
        void vscode.window.showWarningMessage(
          'Restura: no opencollection.yml found for this file.'
        );
        return;
      }

      const scanned = await scanCollection(root);
      const target = scanned.find((r) => r.filePath === filePath);
      if (!target) {
        void vscode.window.showWarningMessage('Restura: this request is not runnable by the CLI.');
        return;
      }

      const { allowLocalhost, envFile } = getResturaSettings();
      const cliCommand = resolveCliCommand(vscode.workspace.workspaceFolders?.[0]);

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: `Restura: running ${target.name}…` },
        async () => {
          try {
            const result = await runViaShell({
              cliCommand,
              collectionDir: root,
              allowLocalhost,
              include: [target.name],
              ...(target.folderPath.length > 0 ? { folder: target.folderPath.join('/') } : {}),
              ...(envFile ? { envFile } : {}),
            });
            const targetKey = resultKey(target.folderPath, target.name);
            const match = result.requests.find(
              (r) => resultKey(r.request.folderPath, r.request.request.name) === targetKey
            );
            if (!match) {
              void vscode.window.showWarningMessage(`Restura: no result for ${target.name}.`);
              return;
            }
            const outcome = classifyOutcome(match);
            output.appendLine(`[${new Date().toISOString()}] ${target.name}: ${outcome.kind}`);
            for (const a of match.assertions ?? []) {
              output.appendLine(`  ${formatAssertion(a)}`);
            }
            if (outcome.kind === 'passed') {
              void vscode.window.showInformationMessage(
                `✓ ${target.name} passed (${outcome.durationMs} ms)`
              );
            } else {
              output.show(true);
              void vscode.window.showErrorMessage(
                `✗ ${target.name} ${outcome.kind}: ${outcome.message}`
              );
            }
          } catch (err) {
            const message = err instanceof ShellRunError ? err.message : String(err);
            void vscode.window.showErrorMessage(`Restura: ${message}`);
          }
        }
      );
    })
  );
}
