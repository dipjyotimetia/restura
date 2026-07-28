// @vitest-environment node
//
// Structural parity test for the IPC surface. Now that channel names are
// centralized in electron/shared/channels.ts, this guards the three-way
// contract that channel centralization is meant to enforce:
//   1. every channel value is unique (no copy-paste collisions),
//   2. every IPC.<group>.<name> constant is bound by the preload bridge
//      (the renderer can actually reach it), and
//   3. every IPC.<group>.<name> constant is registered by some main handler
//      (the main process actually answers it).
// A new channel that is added to the registry but wired up on only one side
// (or neither) fails here, before it can ship as a silent dead channel.

import { parse } from '@babel/parser';
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  ALL_IPC_CHANNELS,
  CHANNEL_PREFIXES,
  EVENT,
  EVENT_PREFIX,
  IPC,
  VALID_EVENT_CHANNELS,
} from '../../shared/channels';

// Vitest runs from the repo root; resolve the handler dir from cwd so this
// file type-checks under the electron program's CJS output (no import.meta).
const MAIN_DIR = path.resolve(process.cwd(), 'electron/main');

interface TypeScriptSource {
  filePath: string;
  source: string;
}

type AstRecord = Record<string, unknown> & {
  type?: string;
  loc?: { start?: { line?: number } };
};

function isRecord(value: unknown): value is AstRecord {
  return typeof value === 'object' && value !== null;
}

function identifierName(value: unknown): string | undefined {
  return isRecord(value) && value.type === 'Identifier' && typeof value.name === 'string'
    ? value.name
    : undefined;
}

function literalText(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type === 'StringLiteral' && typeof value.value === 'string') return value.value;
  if (
    value.type === 'TemplateLiteral' &&
    Array.isArray(value.expressions) &&
    value.expressions.length === 0 &&
    Array.isArray(value.quasis) &&
    isRecord(value.quasis[0])
  ) {
    const quasiValue = value.quasis[0].value;
    if (isRecord(quasiValue) && typeof quasiValue.cooked === 'string') return quasiValue.cooked;
  }
  return undefined;
}

/** Read TypeScript sources recursively under one explicit ownership root. */
function readTypeScriptSourceFiles(directory: string, exclude: string[] = []): TypeScriptSource[] {
  const walk = (dir: string): TypeScriptSource[] => {
    const out: TypeScriptSource[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__tests__') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (exclude.includes(entry.name)) continue;
        out.push(...walk(full));
      } else if (entry.name.endsWith('.ts') && !exclude.includes(entry.name)) {
        out.push({ filePath: full, source: fs.readFileSync(full, 'utf8') });
      }
    }
    return out;
  };
  return walk(directory);
}

function walkAst(value: unknown, visit: (node: AstRecord) => void): void {
  if (Array.isArray(value)) {
    for (const child of value) walkAst(child, visit);
    return;
  }
  if (!isRecord(value)) return;

  visit(value);
  for (const [key, child] of Object.entries(value)) {
    if (key === 'loc' || key.endsWith('Comments')) continue;
    walkAst(child, visit);
  }
}

function parseTypeScript(source: string): AstRecord {
  return parse(source, {
    sourceType: 'unambiguous',
    plugins: ['typescript'],
  }).program as unknown as AstRecord;
}

function callLocation(filePath: string, call: AstRecord): string {
  const line = call.loc?.start?.line ?? 0;
  return `${path.relative(process.cwd(), filePath)}:${line}`;
}

function memberExpressionParts(
  value: unknown
): { receiver: unknown; property?: string } | undefined {
  if (!isRecord(value) || value.type !== 'MemberExpression') return undefined;
  return { receiver: value.object, property: identifierName(value.property) };
}

function findRawIpcMainChannels(sources: TypeScriptSource[]): string[] {
  const methods = new Set(['handle', 'on', 'once', 'removeHandler', 'removeAllListeners']);
  const violations: string[] = [];

  for (const { filePath, source } of sources) {
    walkAst(parseTypeScript(source), (node) => {
      if (node.type !== 'CallExpression') return;
      const callee = memberExpressionParts(node.callee);
      const args = Array.isArray(node.arguments) ? node.arguments : [];
      const channel = literalText(args[0]);
      if (
        callee !== undefined &&
        identifierName(callee.receiver) === 'ipcMain' &&
        callee.property !== undefined &&
        methods.has(callee.property) &&
        channel !== undefined
      ) {
        violations.push(
          `${callLocation(filePath, node)} ipcMain.${callee.property}(${JSON.stringify(channel)})`
        );
      }
    });
  }

  return violations;
}

function findUndocumentedStaticEventChannels(sources: TypeScriptSource[]): string[] {
  const documented = new Set<string>([...Object.values(EVENT), ...VALID_EVENT_CHANNELS]);
  const violations: string[] = [];

  for (const { filePath, source } of sources) {
    walkAst(parseTypeScript(source), (node) => {
      if (node.type !== 'CallExpression') return;
      const callee = memberExpressionParts(node.callee);
      const receiver = memberExpressionParts(callee?.receiver);
      const args = Array.isArray(node.arguments) ? node.arguments : [];
      const channel = literalText(args[0]);
      if (
        callee?.property === 'send' &&
        receiver?.property === 'webContents' &&
        channel !== undefined &&
        !documented.has(channel)
      ) {
        violations.push(`${callLocation(filePath, node)} ${JSON.stringify(channel)}`);
      }
    });
  }

  return violations;
}

const preloadSourceFiles = [
  {
    filePath: path.join(MAIN_DIR, 'preload.ts'),
    source: fs.readFileSync(path.join(MAIN_DIR, 'preload.ts'), 'utf8'),
  },
  ...readTypeScriptSourceFiles(path.join(MAIN_DIR, 'preload')),
];
const preloadSrc = [...preloadSourceFiles.map(({ source }) => source)].join('\n');
// Handler corpus = all main sources except the preload bridge itself.
const handlerSourceFiles = readTypeScriptSourceFiles(MAIN_DIR, ['preload.ts', 'preload']);
const handlerSrc = handlerSourceFiles.map(({ source }) => source).join('\n');

// Flatten IPC into { ref: 'IPC.group.name', value: 'group:name' } rows.
const ipcEntries = Object.entries(IPC).flatMap(([group, channels]) =>
  Object.entries(channels).map(([name, value]) => ({
    ref: `IPC.${group}.${name}`,
    value: value as string,
  }))
);

describe('IPC channel registry parity', () => {
  it('ALL_IPC_CHANNELS mirrors the flattened IPC map', () => {
    expect([...ALL_IPC_CHANNELS].sort()).toEqual(ipcEntries.map((e) => e.value).sort());
  });

  it('has no duplicate channel string values across the whole registry', () => {
    const all = [
      ...ipcEntries.map((e) => e.value),
      ...Object.values(EVENT),
      ...Object.values(EVENT_PREFIX).flatMap((g) => Object.values(g)),
      ...Object.values(CHANNEL_PREFIXES),
    ];
    const dupes = all.filter((v, i) => all.indexOf(v) !== i);
    expect(dupes).toEqual([]);
  });

  it.each(ipcEntries)('preload binds $ref', ({ ref }) => {
    expect(preloadSrc).toContain(ref);
  });

  it.each(ipcEntries)('a main handler registers $ref', ({ ref }) => {
    expect(handlerSrc).toContain(ref);
  });

  it('uses canonical constants for command registration and teardown', () => {
    // Static main→renderer events are a different surface: literal sends are
    // permitted only when declared by EVENT or VALID_EVENT_CHANNELS, and are
    // checked separately below. Renderer→main commands have no raw-literal
    // exception because IPC is their single source of truth.
    expect(findRawIpcMainChannels(handlerSourceFiles)).toEqual([]);
  });

  it('documents every raw static main-to-renderer event channel', () => {
    expect(findUndocumentedStaticEventChannels(handlerSourceFiles)).toEqual([]);
  });

  it('every preload event-bridge prefix is a registered CHANNEL_PREFIXES value', () => {
    // The bridge guard is `channelEventBridge(CHANNEL_PREFIXES.x)`; ensure no
    // raw `channel.startsWith('...')` literal crept back into preload.
    expect(preloadSrc).not.toMatch(/startsWith\(['"][a-z]+:['"]\)/);
    for (const prefix of Object.values(CHANNEL_PREFIXES)) {
      const key = Object.entries(CHANNEL_PREFIXES).find(([, v]) => v === prefix)?.[0];
      expect(preloadSrc).toContain(`CHANNEL_PREFIXES.${key}`);
    }
  });
});
