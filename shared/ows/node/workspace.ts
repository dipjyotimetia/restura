import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { isOwsBindings, type OwsBindings, type OwsLayout } from '../bindings';
import { type OwsWorkflow, validateOwsProfile } from '../workflow-profile';
import {
  normalizeOwsWorkflowWithSdk,
  parseOwsWorkflowJsonWithSdk,
  serializeOwsWorkflowJsonWithSdk,
} from '../workflow-sdk';

const WORKFLOWS_DIR = 'workflows';
const WORKFLOW_FILE = 'workflow.ows.json';
const BINDINGS_FILE = 'bindings.restura.json';
const LAYOUT_FILE = 'layout.restura.json';
const ARTIFACT_FILES = [WORKFLOW_FILE, BINDINGS_FILE, LAYOUT_FILE] as const;
const REQUIRED_ARTIFACT_FILES = [WORKFLOW_FILE, BINDINGS_FILE] as const;
const WINDOWS_RESERVED_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);

const saveLocks = new Map<string, Promise<unknown>>();

export interface OwsWorkflowArtifact {
  workflow: OwsWorkflow;
  bindings: OwsBindings;
  layout: OwsLayout;
}

const DEFAULT_LAYOUT: OwsLayout = { version: 1, nodes: {} };

interface ArtifactContents {
  [WORKFLOW_FILE]: string;
  [BINDINGS_FILE]: string;
  [LAYOUT_FILE]: string;
}

function isPortableWorkflowId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(id) && !WINDOWS_RESERVED_NAMES.has(id.toLowerCase());
}

function assertWorkflowId(id: string): void {
  if (!isPortableWorkflowId(id)) {
    throw new Error(
      'OWS workflow id must be a portable lowercase identifier of up to 63 letters, digits, or hyphens.'
    );
  }
}

function artifactDirectory(root: string, id: string): string {
  const target = resolve(root, WORKFLOWS_DIR, id);
  if (relative(root, target).startsWith(`..${sep}`) || relative(root, target) === '..') {
    throw new Error('Unsafe OWS workflow path.');
  }
  return target;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isOwsLayout(value: unknown): value is OwsLayout {
  return isRecord(value) && value.version === 1 && isRecord(value.nodes);
}

function collectTaskPaths(list: unknown, path: string, output: Set<string>): void {
  if (!Array.isArray(list)) return;
  for (const [index, entry] of list.entries()) {
    if (!isRecord(entry)) continue;
    const entries = Object.entries(entry);
    if (entries.length !== 1) continue;
    const [name, task] = entries[0]!;
    const taskPath = `${path}/${index}/${name}`;
    output.add(taskPath);
    if (!isRecord(task)) continue;
    collectTaskPaths(task.do, `${taskPath}/do`, output);
    if (isRecord(task.fork)) {
      collectTaskPaths(task.fork.branches, `${taskPath}/fork/branches`, output);
    }
    collectTaskPaths(task.try, `${taskPath}/try`, output);
    if (isRecord(task.catch)) collectTaskPaths(task.catch.do, `${taskPath}/catch/do`, output);
  }
}

function assertFinitePosition(
  value: unknown,
  label: string
): asserts value is { x: number; y: number } {
  if (
    !isRecord(value) ||
    !Number.isFinite(value.x) ||
    !Number.isFinite(value.y) ||
    Object.keys(value).some((key) => key !== 'x' && key !== 'y')
  ) {
    throw new Error(`OWS layout position is invalid: ${label}`);
  }
}

function validateArtifact(workflow: OwsWorkflow, bindings: OwsBindings, layout: OwsLayout): void {
  const profile = validateOwsProfile(workflow);
  if (!profile.ok) throw new Error(profile.issues.map((issue) => issue.message).join(' '));
  if (!isOwsBindings(bindings) || !isRecord(bindings.tasks)) {
    throw new Error('Invalid OWS bindings artifact.');
  }
  if (!isOwsLayout(layout)) {
    throw new Error('Invalid OWS layout artifact.');
  }
  if (
    Object.keys(layout).some((key) => key !== 'version' && key !== 'nodes' && key !== 'viewport')
  ) {
    throw new Error('Invalid OWS layout artifact.');
  }
  if (layout.viewport !== undefined) {
    if (
      !isRecord(layout.viewport) ||
      !Number.isFinite(layout.viewport.x) ||
      !Number.isFinite(layout.viewport.y) ||
      !Number.isFinite(layout.viewport.zoom) ||
      layout.viewport.zoom <= 0 ||
      Object.keys(layout.viewport).some((key) => key !== 'x' && key !== 'y' && key !== 'zoom')
    ) {
      throw new Error('OWS layout viewport is invalid.');
    }
  }

  const paths = new Set<string>();
  collectTaskPaths(workflow.do, '/do', paths);
  for (const taskPath of Object.keys(bindings.tasks)) {
    if (!paths.has(taskPath)) throw new Error(`OWS binding task path does not exist: ${taskPath}`);
  }
  for (const [taskPath, position] of Object.entries(layout.nodes)) {
    if (!paths.has(taskPath)) throw new Error(`OWS layout task path does not exist: ${taskPath}`);
    assertFinitePosition(position, taskPath);
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])])
  );
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

async function assertNotSymlink(target: string): Promise<void> {
  try {
    if ((await lstat(target)).isSymbolicLink()) {
      throw new Error(`Refusing to access OWS workspace through symbolic link: ${target}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function assertNoSymlinkPath(root: string, relativePath: string): Promise<void> {
  await assertNotSymlink(root);
  let current = root;
  for (const segment of relativePath.split(/[\\/]/).filter(Boolean)) {
    current = join(current, segment);
    await assertNotSymlink(current);
  }
}

async function resolveWorkspaceRoot(root: string, create: boolean): Promise<string> {
  const resolved = resolve(root);
  if (create) await mkdir(resolved, { recursive: true });
  await assertNotSymlink(resolved);
  return realpath(resolved);
}

async function validateExistingArtifactDirectory(root: string, id: string): Promise<boolean> {
  const directory = artifactDirectory(root, id);
  await assertNoSymlinkPath(root, join(WORKFLOWS_DIR, id));
  try {
    const stats = await lstat(directory);
    if (!stats.isDirectory()) throw new Error(`OWS artifact path is not a directory: ${id}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }

  const entries = await readdir(directory, { withFileTypes: true });
  if (
    entries.length < REQUIRED_ARTIFACT_FILES.length ||
    entries.length > ARTIFACT_FILES.length ||
    entries.some((entry) => !ARTIFACT_FILES.includes(entry.name as (typeof ARTIFACT_FILES)[number]))
  ) {
    throw new Error('OWS artifact directory contains unsupported files.');
  }
  for (const file of REQUIRED_ARTIFACT_FILES) {
    const target = join(directory, file);
    await assertNoSymlinkPath(root, join(WORKFLOWS_DIR, id, file));
    try {
      if (!(await lstat(target)).isFile()) {
        throw new Error(`OWS artifact path is not a regular file: ${file}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`OWS artifact directory is missing required file: ${file}`);
      }
      throw error;
    }
  }
  const layout = join(directory, LAYOUT_FILE);
  await assertNoSymlinkPath(root, join(WORKFLOWS_DIR, id, LAYOUT_FILE));
  try {
    if (!(await lstat(layout)).isFile()) {
      throw new Error(`OWS artifact path is not a regular file: ${LAYOUT_FILE}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return true;
}

/**
 * Swap a complete validated artifact directory into place. A watcher may see
 * the directory disappear briefly during the two renames, but it can never
 * observe a partially old and partially new workflow triplet.
 */
async function replaceArtifactSet(
  root: string,
  id: string,
  staging: string,
  backup: string
): Promise<void> {
  const directory = artifactDirectory(root, id);
  const hadExistingDirectory = await validateExistingArtifactDirectory(root, id);
  const backupDirectory = join(backup, id);
  let movedExistingDirectory = false;
  try {
    if (hadExistingDirectory) {
      await rename(directory, backupDirectory);
      movedExistingDirectory = true;
    }
    await rename(staging, directory);
  } catch (error) {
    if (movedExistingDirectory) {
      await rename(backupDirectory, directory).catch(() => undefined);
    }
    throw error;
  }
}

async function validateStagedArtifact(directory: string): Promise<void> {
  const [source, bindingsSource, layoutSource] = await Promise.all([
    readFile(join(directory, WORKFLOW_FILE), 'utf8'),
    readFile(join(directory, BINDINGS_FILE), 'utf8'),
    readFile(join(directory, LAYOUT_FILE), 'utf8'),
  ]);
  const workflow = parseOwsWorkflowJsonWithSdk(source);
  const bindings = JSON.parse(bindingsSource) as unknown;
  const layout = JSON.parse(layoutSource) as unknown;
  if (!isOwsBindings(bindings) || !isOwsLayout(layout)) {
    throw new Error('Invalid staged OWS workspace artifacts.');
  }
  validateArtifact(workflow, bindings, layout);
}

async function withSaveLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = saveLocks.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  saveLocks.set(key, current);
  try {
    return await current;
  } finally {
    if (saveLocks.get(key) === current) saveLocks.delete(key);
  }
}

export async function saveOwsWorkflowArtifact(
  root: string,
  id: string,
  input: OwsWorkflow,
  bindings: OwsBindings,
  layout: OwsLayout
): Promise<void> {
  assertWorkflowId(id);
  const workflow = normalizeOwsWorkflowWithSdk(input);
  validateArtifact(workflow, bindings, layout);
  const contents: ArtifactContents = {
    [WORKFLOW_FILE]: `${serializeOwsWorkflowJsonWithSdk(workflow)}\n`,
    [BINDINGS_FILE]: canonicalJson(bindings),
    [LAYOUT_FILE]: canonicalJson(layout),
  };
  const lockKey = resolve(root, WORKFLOWS_DIR, id);

  await withSaveLock(lockKey, async () => {
    const workspaceRoot = await resolveWorkspaceRoot(root, true);
    const workflows = join(workspaceRoot, WORKFLOWS_DIR);
    await mkdir(workflows, { recursive: true });
    await assertNoSymlinkPath(workspaceRoot, WORKFLOWS_DIR);
    const staging = await mkdtemp(join(workflows, '.restura-ows-stage-'));
    const backup = await mkdtemp(join(workflows, '.restura-ows-backup-'));
    try {
      await Promise.all(
        ARTIFACT_FILES.map((file) => writeFile(join(staging, file), contents[file], 'utf8'))
      );
      await validateStagedArtifact(staging);
      await replaceArtifactSet(workspaceRoot, id, staging, backup);
    } finally {
      await Promise.all([
        rm(staging, { recursive: true, force: true }),
        rm(backup, { recursive: true, force: true }),
      ]);
    }
  });
}

/** Lists portable workflow artifact directory identifiers without dereferencing links. */
export async function listOwsWorkflowArtifactIds(root: string): Promise<string[]> {
  const workspaceRoot = await resolveWorkspaceRoot(root, false);
  const workflows = join(workspaceRoot, WORKFLOWS_DIR);
  await assertNoSymlinkPath(workspaceRoot, WORKFLOWS_DIR);
  let entries: import('node:fs').Dirent<string>[];
  try {
    entries = await readdir(workflows, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const ids: string[] = [];
  for (const entry of entries) {
    if (!isPortableWorkflowId(entry.name)) continue;
    const relativeDirectory = join(WORKFLOWS_DIR, entry.name);
    await assertNoSymlinkPath(workspaceRoot, relativeDirectory);
    if (!entry.isDirectory()) {
      throw new Error(`OWS workflow artifact path is not a directory: ${entry.name}`);
    }
    ids.push(entry.name);
  }
  return ids.sort();
}

export async function loadOwsWorkflowArtifact(
  root: string,
  id: string
): Promise<OwsWorkflowArtifact> {
  assertWorkflowId(id);
  const workspaceRoot = await resolveWorkspaceRoot(root, false);
  const directory = artifactDirectory(workspaceRoot, id);
  await assertNoSymlinkPath(workspaceRoot, join(WORKFLOWS_DIR, id));
  for (const file of ARTIFACT_FILES) {
    await assertNoSymlinkPath(workspaceRoot, join(WORKFLOWS_DIR, id, file));
  }
  const [source, bindingsSource, layoutSource] = await Promise.all([
    readFile(join(directory, WORKFLOW_FILE), 'utf8'),
    readFile(join(directory, BINDINGS_FILE), 'utf8'),
    readFile(join(directory, LAYOUT_FILE), 'utf8').catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }),
  ]);
  const workflow = parseOwsWorkflowJsonWithSdk(source);
  const bindings = JSON.parse(bindingsSource) as unknown;
  const layout =
    layoutSource === undefined ? DEFAULT_LAYOUT : (JSON.parse(layoutSource) as unknown);
  if (!isOwsBindings(bindings) || !isOwsLayout(layout)) {
    throw new Error('Invalid OWS workspace artifacts.');
  }
  validateArtifact(workflow, bindings, layout);
  return { workflow, bindings, layout };
}

/** Remove one complete validated workflow artifact directory, never a path outside the workspace. */
export async function deleteOwsWorkflowArtifact(root: string, id: string): Promise<void> {
  assertWorkflowId(id);
  const workspaceRoot = await resolveWorkspaceRoot(root, false);
  const directory = artifactDirectory(workspaceRoot, id);
  if (!(await validateExistingArtifactDirectory(workspaceRoot, id))) {
    throw new Error(`OWS workflow artifact was not found: ${id}`);
  }
  await rm(directory, { recursive: true, force: false });
}
