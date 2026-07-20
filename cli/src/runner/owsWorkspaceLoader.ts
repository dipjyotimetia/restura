import { lstat, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadCollectionFromFile } from '@shared/opencollection/node/fs-reader';
import { loadOwsWorkflowArtifact, type OwsWorkflowArtifact } from '@shared/ows/node/workspace';

const WORKFLOWS_DIRECTORY = 'workflows';
const REQUIRED_ARTIFACTS = new Set(['workflow.ows.json', 'bindings.restura.json']);
const OPTIONAL_ARTIFACTS = new Set(['layout.restura.json']);
const WORKFLOW_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

export interface DiscoveredOwsWorkflow {
  /** Portable workspace directory name and OWS workflow identifier. */
  id: string;
  /** Validated OWS executable document and Restura-owned companion artifacts. */
  artifact: OwsWorkflowArtifact;
}

export interface OwsWorkspaceDiscovery {
  /** Canonical absolute workspace root. */
  root: string;
  /** Validated, deterministic workflow order. This API deliberately does not execute them. */
  workflows: DiscoveredOwsWorkflow[];
}

async function assertDirectory(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) {
    throw new Error(`Refusing to discover OWS workspace through symbolic link: ${path}`);
  }
  if (!info.isDirectory()) throw new Error(`${label} must be a directory: ${path}`);
}

async function assertRegularFile(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) {
    throw new Error(`Refusing to discover OWS workspace through symbolic link: ${path}`);
  }
  if (!info.isFile()) throw new Error(`${label} must be a regular file: ${path}`);
}

async function hasDirectory(path: string): Promise<boolean> {
  try {
    await assertDirectory(path, 'OWS workflows path');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function assertArtifactDirectory(path: string, id: string): Promise<void> {
  await assertDirectory(path, `OWS workflow '${id}'`);
  const entries = await readdir(path, { withFileTypes: true });
  const names = new Set(entries.map((entry) => entry.name));

  const unexpected = entries.find(
    (entry) =>
      entry.isSymbolicLink() ||
      !entry.isFile() ||
      (!REQUIRED_ARTIFACTS.has(entry.name) && !OPTIONAL_ARTIFACTS.has(entry.name))
  );
  if (
    unexpected ||
    names.size < REQUIRED_ARTIFACTS.size ||
    names.size > REQUIRED_ARTIFACTS.size + OPTIONAL_ARTIFACTS.size
  ) {
    throw new Error(
      `OWS workflow '${id}' contains legacy or unsupported artifacts; expected workflow.ows.json and bindings.restura.json with an optional layout.restura.json.`
    );
  }

  for (const artifact of REQUIRED_ARTIFACTS) {
    if (!names.has(artifact)) {
      throw new Error(
        `OWS workflow '${id}' contains legacy or unsupported artifacts; missing ${artifact}.`
      );
    }
    await assertRegularFile(join(path, artifact), `OWS artifact '${artifact}'`);
  }
}

/**
 * Discover OWS artifacts from a Git-native OpenCollection workspace.
 *
 * Discovery is intentionally read-only. The workflow runner supplies the only
 * trusted binding resolver; callers that do not use it must not execute these
 * artifacts or advertise support for other protocol/binding kinds.
 */
export async function discoverOwsWorkspace(target: string): Promise<OwsWorkspaceDiscovery> {
  const root = resolve(target);
  await assertDirectory(root, 'OWS workspace root');

  const collectionRoot = join(root, 'opencollection.yml');
  await assertRegularFile(collectionRoot, 'OWS workspace opencollection.yml');
  // A marker alone is not enough: fail closed unless it is a valid OpenCollection document.
  await loadCollectionFromFile(collectionRoot);

  const workflowsPath = join(root, WORKFLOWS_DIRECTORY);
  if (!(await hasDirectory(workflowsPath))) return { root, workflows: [] };

  const entries = await readdir(workflowsPath, { withFileTypes: true });
  const ids = entries.map((entry) => entry.name).sort((left, right) => left.localeCompare(right));
  const workflows: DiscoveredOwsWorkflow[] = [];

  for (const id of ids) {
    const entry = entries.find((candidate) => candidate.name === id);
    if (!entry) {
      throw new Error(`OWS workflows contains a legacy or unsupported entry: ${id}`);
    }
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Refusing to discover OWS workspace through symbolic link: ${join(workflowsPath, id)}`
      );
    }
    if (!entry.isDirectory() || !WORKFLOW_ID.test(id)) {
      throw new Error(`OWS workflows contains a legacy or unsupported entry: ${id}`);
    }
    await assertArtifactDirectory(join(workflowsPath, id), id);
    workflows.push({ id, artifact: await loadOwsWorkflowArtifact(root, id) });
  }

  return { root, workflows };
}
