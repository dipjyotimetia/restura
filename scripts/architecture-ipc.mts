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
  /**
   * Registration helpers imported from another module (same-file helpers are
   * derived automatically). Name → reason.
   */
  registrationHelpers?: Record<string, string>;
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
  /** Files scanned per side — an empty side means the policy paths are stale (fail closed). */
  counts: { registryFiles: number; mainFiles: number; preloadFiles: number };
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

/** A child-node list of a Babel node (always an array in Babel's AST; `[]` if absent). */
function list(node: AstRecord, key: string): unknown[] {
  const value = node[key];
  return Array.isArray(value) ? value : [];
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
    if (!isRecord(init) || init.type !== 'ObjectExpression') return false;
    for (const group of list(init, 'properties')) {
      if (!isRecord(group) || group.type !== 'ObjectProperty') continue;
      const groupName = propertyName(group);
      const value = unwrapExpression(group.value);
      if (!groupName || !isRecord(value) || value.type !== 'ObjectExpression') continue;
      for (const entry of list(value, 'properties')) {
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

const REGISTRATION_CALLEE = /(?:^|\.)ipcMain\.(?:handle|handleOnce|on|once)$/;
const VALIDATED_WRAPPER = /^createValidated\w*$/;

function functionParamNames(fn: AstRecord): string[] {
  return list(fn, 'params').flatMap((param) => {
    const target = isRecord(param) && param.type === 'AssignmentPattern' ? param.left : param;
    return isRecord(target) && target.type === 'Identifier' && typeof target.name === 'string'
      ? [target.name]
      : [];
  });
}

function namedFunctions(ast: AstRecord): Array<{ name: string; fn: AstRecord }> {
  const found: Array<{ name: string; fn: AstRecord }> = [];
  walk(ast, (node) => {
    if (node.type === 'FunctionDeclaration' && isRecord(node.id)) {
      found.push({ name: String(node.id.name), fn: node });
    } else if (node.type === 'VariableDeclarator' && isRecord(node.id)) {
      const init = node.init;
      if (
        isRecord(init) &&
        (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression') &&
        typeof node.id.name === 'string'
      ) {
        found.push({ name: node.id.name, fn: init });
      }
    }
    return true;
  });
  return found;
}

/** Bindings introduced by a loop/forEach target: plain identifiers and array-pattern elements. */
function bindingNames(node: unknown): string[] {
  if (!isRecord(node)) return [];
  if (node.type === 'VariableDeclaration') {
    return list(node, 'declarations').flatMap((d) => bindingNames((d as AstRecord).id));
  }
  if (node.type === 'Identifier' && typeof node.name === 'string') return [node.name];
  if (node.type === 'ArrayPattern') return list(node, 'elements').flatMap(bindingNames);
  return [];
}

/** Registry keys / groups an iterable expression yields (`IPC.g`, `Object.values(IPC.g)`, `[IPC.g.k]`). */
function iterableRefs(node: unknown): { keys: string[]; groups: string[] } {
  const target = unwrapExpression(node);
  const result = { keys: [] as string[], groups: [] as string[] };
  if (!isRecord(target)) return result;
  if (target.type === 'ArrayExpression') {
    for (const element of list(target, 'elements')) {
      const chain = memberChain(element);
      if (chain?.[0] === 'IPC' && chain.length >= 3) result.keys.push(`${chain[1]}.${chain[2]}`);
    }
    return result;
  }
  let source: unknown = target;
  if (target.type === 'CallExpression') {
    const callee = memberChain(target.callee)?.join('.');
    if (!callee || !/^Object\.(?:values|keys|entries)$/.test(callee)) return result;
    source = list(target, 'arguments')[0];
  }
  const chain = memberChain(source);
  if (chain?.[0] === 'IPC' && chain.length === 2) result.groups.push(chain[1]!);
  return result;
}

/**
 * Registry keys (and whole groups) that one Electron main file actually
 * REGISTERS: an `IPC.group.key` passed directly to `ipcMain.handle/handleOnce/
 * on/once`, a `createValidated*` wrapper, or a local registration helper (a
 * function in the same file that forwards one of its parameters to such a
 * call — derived mechanically). Loop/forEach variables over `IPC.group`,
 * `Object.values|keys|entries(IPC.group)` or `[IPC.g.k, …]` count when they
 * feed a registration call. Teardown (`removeHandler`) never counts.
 */
export function extractIpcRegistrations(
  filePath: string,
  sourceText: string,
  extraHelpers: readonly string[] = []
): { keys: Set<string>; groups: Set<string> } {
  const ast = parseTs(filePath, sourceText);
  const helpers = new Set(extraHelpers);
  const isRegistration = (call: AstRecord): boolean => {
    const chain = memberChain(call.callee);
    if (!chain) return false;
    const joined = chain.join('.');
    if (REGISTRATION_CALLEE.test(joined)) return true;
    const last = chain[chain.length - 1]!;
    if (VALIDATED_WRAPPER.test(last)) return true;
    return chain.length === 1 && helpers.has(last);
  };
  const callArgs = (call: AstRecord): unknown[] => list(call, 'arguments');
  const forwardsIdentifier = (body: unknown, names: readonly string[]): boolean => {
    let forwards = false;
    walk(body, (node) => {
      if (forwards) return false;
      if (node.type === 'CallExpression' && isRegistration(node)) {
        forwards = callArgs(node).some(
          (arg) => isRecord(arg) && arg.type === 'Identifier' && names.includes(String(arg.name))
        );
      }
      return true;
    });
    return forwards;
  };

  const functions = namedFunctions(ast);
  for (let changed = true; changed; ) {
    changed = false;
    for (const { name, fn } of functions) {
      if (helpers.has(name)) continue;
      const params = functionParamNames(fn);
      if (params.length > 0 && forwardsIdentifier(fn.body, params)) {
        helpers.add(name);
        changed = true;
      }
    }
  }

  const keys = new Set<string>();
  const groups = new Set<string>();
  const addIterated = (iterable: unknown, names: string[], body: unknown): void => {
    if (names.length === 0 || !forwardsIdentifier(body, names)) return;
    const refs = iterableRefs(iterable);
    for (const key of refs.keys) keys.add(key);
    for (const group of refs.groups) groups.add(group);
  };
  walk(ast, (node) => {
    if (node.type === 'ForOfStatement' || node.type === 'ForInStatement') {
      addIterated(node.right, bindingNames(node.left), node.body);
    } else if (node.type === 'CallExpression') {
      const callee = node.callee;
      if (
        isRecord(callee) &&
        callee.type === 'MemberExpression' &&
        isRecord(callee.property) &&
        callee.property.name === 'forEach'
      ) {
        const fn = callArgs(node)[0];
        if (isRecord(fn)) {
          const params = list(fn, 'params').flatMap(bindingNames);
          addIterated(callee.object, params, fn.body);
        }
      }
      if (isRegistration(node)) {
        for (const arg of callArgs(node)) {
          const chain = memberChain(arg);
          if (chain?.[0] === 'IPC' && chain.length >= 3) keys.add(`${chain[1]}.${chain[2]}`);
        }
      }
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
      const typeName = (node.typeAnnotation as AstRecord).typeName;
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
    for (const declarator of list(declaration, 'declarations') as AstRecord[]) {
      const init = unwrapExpression(declarator.init);
      if (!isRecord(init) || init.type !== 'ObjectExpression') continue;
      const id = declarator.id as AstRecord;
      if (!id.typeAnnotation) {
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
    counts: { registryFiles: 0, mainFiles: 0, preloadFiles: 0 },
  };
  const registryFiles: string[] = [];
  listTsFiles(path.join(root, policy.registryDir), registryFiles);
  surface.counts.registryFiles = registryFiles.length;
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
    if (isPreload) surface.counts.preloadFiles++;
    else surface.counts.mainFiles++;
    const { keys, groups } = isPreload
      ? extractIpcReferences(relative, sourceText)
      : extractIpcRegistrations(
          relative,
          sourceText,
          Object.keys(policy.registrationHelpers ?? {})
        );
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
      message: `${policy.preloadEntry} (the contextBridge entry) is missing; update ipcTriplePolicy.preloadEntry in scripts/architecture.config.mts`,
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
  const stale = (what: string, where: string) =>
    violations.push({
      rule: 'ipc-triple',
      file: where,
      message: `IPC triple check found ${what} under ${where}; the check would pass vacuously. If the IPC registry, Electron main or preload moved, update ipcTriplePolicy in scripts/architecture.config.mts`,
    });
  if (surface.counts.registryFiles === 0) stale('no registry modules', policy.registryDir);
  else if (surface.registry.size === 0) {
    stale(
      'no `export const *_IPC = { group: { key: ... } }` registry literals',
      policy.registryDir
    );
  }
  if (surface.counts.mainFiles === 0) stale('no Electron main source files', policy.mainRoot);
  if (surface.counts.preloadFiles === 0) {
    stale('no preload files', `${policy.preloadEntry}, ${policy.preloadDir}`);
  }

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
        message: `IPC.${key} (${file}) is never exposed by the preload bridge: add the invoke/send exposure in ${policy.preloadDir}<domain>-api.ts and its type under electron/types/api/ (composed into ElectronAPI) — or, if it is deliberately main-only, add it to ipcTriplePolicy.mainOnlyChannels with a reason`,
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
          message: `ipcTriplePolicy.${listName} entry '${key}' is no longer needed; remove it`,
        });
      }
    }
  }

  for (const problem of surface.bindingProblems) {
    violations.push({ rule: 'ipc-triple', file: problem.file, message: problem.message });
  }
  return { violations, warnings };
}
