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

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  IPC,
  EVENT,
  EVENT_PREFIX,
  CHANNEL_PREFIXES,
  ALL_IPC_CHANNELS,
} from '../../shared/channels';

// Vitest runs from the repo root; resolve the handler dir from cwd so this
// file type-checks under the electron program's CJS output (no import.meta).
const MAIN_DIR = path.resolve(process.cwd(), 'electron/main');

/** Read every top-level `electron/main/*.ts` source (excluding tests). */
function readMainSources(exclude: string[] = []): string {
  return fs
    .readdirSync(MAIN_DIR)
    .filter((f) => f.endsWith('.ts') && !exclude.includes(f))
    .map((f) => fs.readFileSync(path.join(MAIN_DIR, f), 'utf8'))
    .join('\n');
}

const preloadSrc = fs.readFileSync(path.join(MAIN_DIR, 'preload.ts'), 'utf8');
// Handler corpus = all main sources except the preload bridge itself.
const handlerSrc = readMainSources(['preload.ts']);

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
