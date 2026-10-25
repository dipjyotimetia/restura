// IPC triple check: every channel in the Electron IPC registry must be wired
// on both sides of the bridge, and the preload bridge must stay bound to the
// `ElectronAPI` type so the third leg (the renderer-facing type) is enforced
// by `tsc`.
//
// Channels are compared by registry key (`IPC.<group>.<key>`), not by string
// value: both Electron main and the preload bridge reference channels through
// the `IPC` registry (electron/shared/channels.ts), so a missing reference on
// one side is exactly the "window.electron.x is undefined / invoke rejects
// with 'No handler registered'" runtime failure that no type check catches.
import fs from 'node:fs';
import path from 'node:path';
import { parse } from '@babel/parser';
import type { ArchitectureViolation, ArchitectureWarning } from './architecture-policy.mts';

export interface IpcTriplePolicy {
  /** Directory holding the per-area `*_IPC` registry modules. */
  registryDir: string;
  /** Root of Electron main (handlers). Preload paths below are excluded from it. */
  mainRoot: string;
  /** The contextBridge entry; must bind the exposed object with `satisfies ElectronAPI`. */
  preloadEntry: string;
  /** Directory of preload domain modules (`*-api.ts`). */
  preloadDir: string;
  /**
   * Registry keys (`group.key`) handled in main but deliberately not exposed
   * through preload. Value = reason (required, shown in reviews).
   */
  mainOnlyChannels: Record<string, string>;
  /**
   * Registry keys exposed through preload with no main-side reference.
   * Value = reason (required).
   */
  preloadOnlyChannels: Record<string, string>;
}

export interface IpcSurface {
  /** Registry key (`group.key`) → registry file that defines it. */
  registry: Map<string, string>;
  /** Registry keys referenced by Electron main (excluding teardown calls). */
  handled: Set<string>;
  /** Groups referenced wholesale by Electron main (e.g. `Object.values(IPC.kafka)`). */
  handledGroups: Set<string>;
  /** Registry keys referenced by the preload bridge. */
  exposed: Set<string>;
  exposedGroups: Set<string>;
  /** Preload binding problems (missing `satisfies ElectronAPI`, unannotated domain object). */
  bindingProblems: Array<{ file: string; message: string }>;
}

type AstRecord = Record<string, unknown> & { type?: string };

function isRecord(value: unknown): value is AstRecord {
  return typeof value === 'object' && value !== null;
}

function parseTs(filePath: string, sourceText: string): AstRecord {
  return parse(sourceText, {
    sourceType: 'module',
    plugins: filePath.endsWith('.tsx') ? ['typescript', 'jsx'] : ['typescript'],
  }).program as unknown as AstRecord;
}

function unwrapExpression(node: unknown): unknown {
  let current = node;
  while (
    isRecord(current) &&
    (current.type === 'TSAsExpression' ||
      current.type === 'TSSatisfiesExpression' ||
      current.type === 'TSTypeAssertion')
  ) {
    current = current.expression;
  }
  return current;
}

function propertyName(node: AstRecord): string | undefined {
  if (node.computed) return undefined;
  const key = node.key;
  if (!isRecord(key)) return undefined;
  if (key.type === 'Identifier' && typeof key.name === 'string') return key.name;
  if (key.type === 'StringLiteral' && typeof key.value === 'string') return key.value;
  return undefined;
}

function walk(node: unknown, visit: (node: AstRecord, parent?: AstRecord) => boolean | void): void {
  const step = (value: unknown, parent?: AstRecord): void => {
    if (Array.isArray(value)) {
      for (const child of value) step(child, parent);
      return;
    }
    if (!isRecord(value)) return;
    if (visit(value, parent) === false) return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue;
      step(child, value);
    }
  };
  step(node);
}

/** `group.key` entries declared by `export const X_IPC = { group: { key: 'chan' } }`. */
export function extractIpcRegistry(filePath: string, sourceText: string): string[] {
  const keys: string[] = [];
  walk(parseTs(filePath, sourceText), (node) => {
    if (node.type !== 'VariableDeclarator') return;
    const id = node.id;
    if (!isRecord(id) || typeof id.name !== 'string' || !id.name.endsWith('_IPC')) return;
    const init = unwrapExpression(node.init);
    if (!isRecord(init) || init.type !== 'ObjectExpression' || !Array.isArray(init.properties)) {
      return false;
    }
    for (const group of init.properties) {
      if (!isRecord(group) || group.type !== 'ObjectProperty') continue;
      const groupName = propertyName(group);
      const value = unwrapExpression(group.value);
      if (!groupName || !isRecord(value) || value.type !== 'ObjectExpression') continue;
      for (const entry of Array.isArray(value.properties) ? value.properties : []) {
        if (!isRecord(entry) || entry.type !== 'ObjectProperty') continue;
        const name = propertyName(entry);
        if (name) keys.push(`${groupName}.${name}`);
      }
    }
    return false;
  });
  return keys;
}

function memberChain(node: unknown): string[] | undefined {
  if (!isRecord(node)) return undefined;
  if (node.type === 'Identifier' && typeof node.name === 'string') return [node.name];
  if (node.type === 'MemberExpression' && !node.computed) {
    const object = memberChain(node.object);
    const property = node.property;
    if (!object || !isRecord(property) || typeof property.name !== 'string') return undefined;
    return [...object, property.name];
  }
  return undefined;
}

const TEARDOWN_CALLEE = /(?:^|\.)(?:removeHandler|removeListener|removeAllListeners|off)$/;

/**
 * Registry references (`IPC.group.key`) in one source file. References that
 * are only the argument of a teardown call (`ipcMain.removeHandler(...)`) do
 * not count — a dispose without a register is not a handler.
 */
export function extractIpcReferences(
  filePath: string,
  sourceText: string
): { keys: Set<string>; groups: Set<string> } {
  const keys = new Set<string>();
  const groups = new Set<string>();
  walk(parseTs(filePath, sourceText), (node) => {
    if (node.type === 'CallExpression') {
      const callee = memberChain(node.callee)?.join('.');
      if (callee && TEARDOWN_CALLEE.test(callee)) return false;
      return true;
    }
    if (node.type !== 'MemberExpression') return true;
    if (isRecord(node.object) && node.object.type === 'Identifier' && node.object.name === 'IPC') {
      // `IPC.group` not followed by a static key: whole-group reference.
      const property = node.property;
      if (!node.computed && isRecord(property) && typeof property.name === 'string') {
        groups.add(property.name);
      }
      return false;
    }
    const chain = memberChain(node);
    if (chain && chain[0] === 'IPC' && chain.length >= 3) {
      keys.add(`${chain[1]}.${chain[2]}`);
      return false;
    }
    return true;
  });
  return { keys, groups };
}

/** Problems with how a preload module binds its exposed object to `ElectronAPI`. */
export function inspectPreloadBinding(
  filePath: string,
  sourceText: string,
  isEntry: boolean
): string[] {
  const problems: string[] = [];
  const ast = parseTs(filePath, sourceText);
  if (isEntry) {
    let satisfiesElectronApi = false;
    walk(ast, (node) => {
      if (node.type !== 'TSSatisfiesExpression') return;
      const annotation = node.typeAnnotation;
      const typeName = isRecord(annotation) ? annotation.typeName : undefined;
      if (isRecord(typeName) && typeName.name === 'ElectronAPI') satisfiesElectronApi = true;
    });
    if (!satisfiesElectronApi) {
      problems.push(
        `${filePath} must bind the contextBridge object with \`satisfies ElectronAPI\` so a missing preload exposure or type is a compile error`
      );
    }
    return problems;
  }
  walk(ast, (node) => {
    if (node.type !== 'ExportNamedDeclaration') return;
    const declaration = node.declaration;
    if (!isRecord(declaration) || declaration.type !== 'VariableDeclaration') return false;
    for (const declarator of Array.isArray(declaration.declarations)
      ? declaration.declarations
      : []) {
      if (!isRecord(declarator)) continue;
      const init = unwrapExpression(declarator.init);
      if (!isRecord(init) || init.type !== 'ObjectExpression') continue;
      const id = declarator.id;
      if (isRecord(id) && !id.typeAnnotation) {
        problems.push(
          `${filePath}: exported preload object \`${String(id.name)}\` needs a type annotation derived from ElectronAPI (e.g. \`Pick<ElectronAPI, '…'>\`) so its keys are checked against electron/types/api/*`
        );
      }
    }
    return false;
  });
  return problems;
}

function listTsFiles(directory: string, output: string[]): void {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (['node_modules', '__tests__', 'dist', 'out'].includes(entry.name)) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) listTsFiles(entryPath, output);
    else if (/\.ts$/.test(entry.name) && !/\.(?:test|spec)\.ts$/.test(entry.name)) {
      output.push(entryPath);
    }
  }
}

function toRelative(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join('/');
}

export function scanIpcSurface(root: string, policy: IpcTriplePolicy): IpcSurface {
  const surface: IpcSurface = {
    registry: new Map(),
    handled: new Set(),
    handledGroups: new Set(),
    exposed: new Set(),
    exposedGroups: new Set(),
    bindingProblems: [],
  };
  const registryFiles: string[] = [];
  listTsFiles(path.join(root, policy.registryDir), registryFiles);
  for (const absolute of registryFiles.sort()) {
    const relative = toRelative(root, absolute);
    for (const key of extractIpcRegistry(relative, fs.readFileSync(absolute, 'utf8'))) {
      surface.registry.set(key, relative);
    }
  }

  const preloadDir = policy.preloadDir.endsWith('/') ? policy.preloadDir : `${policy.preloadDir}/`;
  const mainFiles: string[] = [];
  listTsFiles(path.join(root, policy.mainRoot), mainFiles);
  for (const absolute of mainFiles.sort()) {
    const relative = toRelative(root, absolute);
    const sourceText = fs.readFileSync(absolute, 'utf8');
    const isEntry = relative === policy.preloadEntry;
    const isPreload = isEntry || relative.startsWith(preloadDir);
    const { keys, groups } = extractIpcReferences(relative, sourceText);
    for (const key of keys) (isPreload ? surface.exposed : surface.handled).add(key);
    for (const group of groups)
      (isPreload ? surface.exposedGroups : surface.handledGroups).add(group);
    if (isPreload) {
      for (const message of inspectPreloadBinding(relative, sourceText, isEntry)) {
        surface.bindingProblems.push({ file: relative, message });
      }
    }
  }
  if (!fs.existsSync(path.join(root, policy.preloadEntry))) {
    surface.bindingProblems.push({
      file: policy.preloadEntry,
      message: `${policy.preloadEntry} (the contextBridge entry) is missing; update ipcTriple.preloadEntry in scripts/architecture.config.mts`,
    });
  }
  return surface;
}

export function evaluateIpcTriple(
  surface: IpcSurface,
  policy: IpcTriplePolicy
): { violations: ArchitectureViolation[]; warnings: ArchitectureWarning[] } {
  const violations: ArchitectureViolation[] = [];
  const warnings: ArchitectureWarning[] = [];
  const groupOf = (key: string) => key.slice(0, key.indexOf('.'));

  for (const [key, file] of [...surface.registry].sort(([a], [b]) => a.localeCompare(b))) {
    const handled = surface.handled.has(key) || surface.handledGroups.has(groupOf(key));
    const exposed = surface.exposed.has(key) || surface.exposedGroups.has(groupOf(key));
    if (!handled && !(key in policy.preloadOnlyChannels)) {
      violations.push({
        rule: 'ipc-triple',
        file,
        message: `IPC.${key} (${file}) has no handler in ${policy.mainRoot}: register it with ipcMain.handle/on wrapped in createValidatedHandler/createValidatedListener (Zod schema in electron/main/ipc/validators/) and add the register/dispose pair to IPC_MODULES in electron/main/main.ts — or delete the unused channel`,
      });
    }
    if (!exposed && !(key in policy.mainOnlyChannels)) {
      violations.push({
        rule: 'ipc-triple',
        file,
        message: `IPC.${key} (${file}) is never exposed by the preload bridge: add the invoke/send exposure in ${policy.preloadDir}<domain>-api.ts and its type under electron/types/api/ (composed into ElectronAPI) — or, if it is deliberately main-only, add it to ipcTriple.mainOnlyChannels with a reason`,
      });
    }
  }

  for (const [listName, list] of [
    ['mainOnlyChannels', policy.mainOnlyChannels],
    ['preloadOnlyChannels', policy.preloadOnlyChannels],
  ] as const) {
    for (const key of Object.keys(list).sort()) {
      const stillNeeded = !surface.registry.has(key)
        ? false
        : listName === 'mainOnlyChannels'
          ? !surface.exposed.has(key)
          : !surface.handled.has(key);
      if (!stillNeeded) {
        warnings.push({
          rule: 'stale-ipc-allowlist',
          file: 'scripts/architecture.config.mts',
          actual: 0,
          limit: 1,
          message: `ipcTriple.${listName} entry '${key}' is no longer needed; remove it`,
        });
      }
    }
  }

  for (const problem of surface.bindingProblems) {
    violations.push({ rule: 'ipc-triple', file: problem.file, message: problem.message });
  }
  return { violations, warnings };
}
