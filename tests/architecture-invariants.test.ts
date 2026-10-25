// CLAUDE.md invariants enforced by `npm run architecture:check`: the IPC
// triple, no new direct localStorage persistence, no DEV_BYPASS_AUTH in
// wrangler config, and the Worker never imported by Electron main / the CLI.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  architecturePolicy,
  forbiddenConfigKeys,
  ipcTriplePolicy,
} from '../scripts/architecture.config.mts';
import {
  evaluateForbiddenConfigKeys,
  scanConfigFiles,
  tokenizeConfig,
} from '../scripts/architecture-config-keys.mts';
import {
  evaluateIpcTriple,
  extractIpcReferences,
  extractIpcRegistrations,
  extractIpcRegistry,
  type IpcTriplePolicy,
  scanIpcSurface,
} from '../scripts/architecture-ipc.mts';
import { countSourcePatterns, evaluateArchitecture } from '../scripts/architecture-policy.mts';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function tempRepo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'restura-arch-inv-'));
  temporaryDirectories.push(root);
  for (const [relative, text] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, text);
  }
  return root;
}

const ipcPolicy: IpcTriplePolicy = {
  registryDir: 'electron/shared/channels/',
  mainRoot: 'electron/main/',
  preloadEntry: 'electron/main/preload.ts',
  preloadDir: 'electron/main/preload/',
  mainOnlyChannels: {},
  preloadOnlyChannels: {},
};

const REGISTRY = `export const DEMO_IPC = {
  demo: {
    ping: 'demo:ping',
    echo: 'demo:echo',
  },
} as const;
`;

const HANDLER = `import { ipcMain } from 'electron';
import { IPC } from '../../shared/channels';
export function registerDemo() {
  ipcMain.handle(IPC.demo.ping, createValidatedHandler(IPC.demo.ping, NoInputSchema, () => 'pong'));
  ipcMain.handle(IPC.demo.echo, createValidatedHandler(IPC.demo.echo, EchoSchema, (x) => x));
}
export function disposeDemo() {
  ipcMain.removeHandler(IPC.demo.ping);
  ipcMain.removeHandler(IPC.demo.echo);
}
`;

const PRELOAD_ENTRY = `import { contextBridge } from 'electron';
import type { ElectronAPI } from '../types/electron-api';
import { demoApi } from './preload/demo-api';
const electronAPI = { ...demoApi } satisfies ElectronAPI;
contextBridge.exposeInMainWorld('electron', electronAPI);
`;

const PRELOAD_DOMAIN = `import { IPC } from '../../shared/channels';
import type { ElectronAPI } from '../../types/electron-api';
import { invoke } from './invoke';
export const demoApi: Pick<ElectronAPI, 'demo'> = {
  demo: {
    ping: invoke(IPC.demo.ping),
    echo: invoke(IPC.demo.echo),
  },
};
`;

function ipcRepo(overrides: Record<string, string> = {}): string {
  return tempRepo({
    'electron/shared/channels/demo.ts': REGISTRY,
    'electron/main/handlers/demo-handler.ts': HANDLER,
    'electron/main/preload.ts': PRELOAD_ENTRY,
    'electron/main/preload/demo-api.ts': PRELOAD_DOMAIN,
    ...overrides,
  });
}

function ipcMessages(root: string, policy: IpcTriplePolicy = ipcPolicy) {
  return evaluateIpcTriple(scanIpcSurface(root, policy), policy);
}

describe('IPC triple', () => {
  it('reads group.key entries from *_IPC registry modules only', () => {
    expect(
      extractIpcRegistry(
        'channels/demo.ts',
        `${REGISTRY}export const DEMO_EVENT = { pushed: 'demo:pushed' } as const;`
      )
    ).toEqual(['demo.ping', 'demo.echo']);
  });

  it('collects IPC.group.key references but not teardown-only ones', () => {
    const refs = extractIpcReferences(
      'main.ts',
      `ipcMain.removeHandler(IPC.demo.ping);
       handle(IPC.demo.echo, schema, run);
       for (const c of Object.values(IPC.bulk)) ipcMain.handle(c, h);`
    );
    expect([...refs.keys]).toEqual(['demo.echo']);
    expect([...refs.groups]).toEqual(['bulk']);
  });

  it('counts only registrations: direct args, derived helpers and iterated groups', () => {
    const refs = extractIpcRegistrations(
      'main.ts',
      `function handle(channel, schema, run) {
         ipcMain.handle(channel, rateLimited(l, createValidatedEventHandler(channel, schema, run)));
       }
       const wrap = (ch) => handle(ch, s, r);
       handle(IPC.a.viaHelper, s, r);
       wrap(IPC.a.viaNestedHelper);
       ipcMain.on(IPC.a.direct, createValidatedListener(IPC.a.direct, s, h));
       for (const c of Object.values(IPC.loopRegistered)) ipcMain.handle(c, h);
       [IPC.b.forEachRegistered].forEach((c) => ipcMain.handle(c, h));
       for (const c of Object.values(IPC.loopTeardown)) ipcMain.removeHandler(c);
       Object.keys(IPC.keysTeardown).forEach((c) => ipcMain.removeHandler(c));
       ipcMain.removeHandler(IPC.a.teardownOnly);
       rateLimits[IPC.a.mentionedOnly] = 5;
       notHelper(IPC.a.unrelatedCall);`
    );
    expect([...refs.keys].sort()).toEqual([
      'a.direct',
      'a.viaHelper',
      'a.viaNestedHelper',
      'b.forEachRegistered',
    ]);
    expect([...refs.groups]).toEqual(['loopRegistered']);
  });

  it('accepts cross-module registration helpers only via the policy list', () => {
    const source = 'registerChannel(IPC.a.b, schema, run);';
    expect([...extractIpcRegistrations('m.ts', source).keys]).toEqual([]);
    expect([...extractIpcRegistrations('m.ts', source, ['registerChannel']).keys]).toEqual(['a.b']);
  });

  it('treats a teardown-only group iteration as unhandled', () => {
    const root = ipcRepo({
      'electron/main/handlers/demo-handler.ts': `import { ipcMain } from 'electron';
export function disposeDemo() {
  for (const channel of Object.values(IPC.demo)) ipcMain.removeHandler(channel);
}
`,
    });
    expect(ipcMessages(root).violations.map((v) => v.message.slice(0, 28))).toEqual([
      'IPC.demo.echo (electron/shar',
      'IPC.demo.ping (electron/shar',
    ]);
  });

  it('fails closed when a scanned side is empty', () => {
    const empty = tempRepo({ 'README.md': '' });
    const messages = ipcMessages(empty).violations.map((v) => v.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringContaining('found no registry modules under electron/shared/channels/'),
        expect.stringContaining('found no Electron main source files under electron/main/'),
        expect.stringContaining('found no preload files'),
      ])
    );
    expect(messages.every((m) => m.includes('ipcTriplePolicy'))).toBe(true);

    const noLiterals = ipcRepo({
      'electron/shared/channels/demo.ts': "export const DEMO = { demo: { ping: 'demo:ping' } };",
    });
    expect(ipcMessages(noLiterals).violations.map((v) => v.message)).toEqual([
      expect.stringContaining('no `export const *_IPC'),
    ]);
  });

  it('passes a fully wired channel set', () => {
    expect(ipcMessages(ipcRepo())).toEqual({ violations: [], warnings: [] });
  });

  it('fails a channel with no main-side handler and says how to fix it', () => {
    const root = ipcRepo({
      'electron/main/handlers/demo-handler.ts': HANDLER.replace(
        /\s*ipcMain\.handle\(IPC\.demo\.echo.*\n/,
        '\n'
      ),
    });
    const { violations } = ipcMessages(root);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      rule: 'ipc-triple',
      file: 'electron/shared/channels/demo.ts',
    });
    expect(violations[0]!.message).toContain('IPC.demo.echo');
    expect(violations[0]!.message).toContain('createValidatedHandler');
    expect(violations[0]!.message).toContain('IPC_MODULES');
  });

  it('fails a channel that the preload bridge never exposes', () => {
    const root = ipcRepo({
      'electron/main/preload/demo-api.ts': PRELOAD_DOMAIN.replace(
        '    echo: invoke(IPC.demo.echo),\n',
        ''
      ),
    });
    const { violations } = ipcMessages(root);
    expect(violations.map((v) => v.message)).toEqual([
      expect.stringContaining(
        'IPC.demo.echo (electron/shared/channels/demo.ts) is never exposed by the preload bridge: add the invoke/send exposure in electron/main/preload/<domain>-api.ts and its type under electron/types/api/'
      ),
    ]);
  });

  it('accepts reasoned exceptions and warns once they go stale', () => {
    const root = ipcRepo({
      'electron/main/preload/demo-api.ts': PRELOAD_DOMAIN.replace(
        '    echo: invoke(IPC.demo.echo),\n',
        ''
      ),
    });
    const policy: IpcTriplePolicy = {
      ...ipcPolicy,
      mainOnlyChannels: { 'demo.echo': 'main-internal', 'demo.ping': 'stale' },
      preloadOnlyChannels: { 'demo.gone': 'removed from registry' },
    };
    const { violations, warnings } = ipcMessages(root, policy);
    expect(violations).toEqual([]);
    expect(warnings.map((w) => w.message)).toEqual([
      "ipcTriplePolicy.mainOnlyChannels entry 'demo.ping' is no longer needed; remove it",
      "ipcTriplePolicy.preloadOnlyChannels entry 'demo.gone' is no longer needed; remove it",
    ]);
  });

  it('fails when the preload bridge is no longer bound to ElectronAPI', () => {
    const root = ipcRepo({
      'electron/main/preload.ts': PRELOAD_ENTRY.replace(' satisfies ElectronAPI', ''),
      'electron/main/preload/demo-api.ts': PRELOAD_DOMAIN.replace(
        ": Pick<ElectronAPI, 'demo'>",
        ''
      ),
    });
    const { violations } = ipcMessages(root);
    expect(violations.map((v) => v.file)).toEqual([
      'electron/main/preload.ts',
      'electron/main/preload/demo-api.ts',
    ]);
    expect(violations[0]!.message).toContain('satisfies ElectronAPI');
    expect(violations[1]!.message).toContain('Pick<ElectronAPI');
  });

  it('holds on the real tree', () => {
    const surface = scanIpcSurface(process.cwd(), ipcTriplePolicy);
    expect(surface.registry.size).toBeGreaterThan(100);
    expect(evaluateIpcTriple(surface, ipcTriplePolicy).violations).toEqual([]);
  });
});

describe('forbidden config keys', () => {
  it('tokenizes away comments but keeps string contents', () => {
    expect(
      tokenizeConfig('{"a": "http://x", // DEV_BYPASS_AUTH\n /* b */ "c": 1}', false).map(
        (t) => t.value
      )
    ).toEqual(['{', 'a', ':', 'http://x', ',', 'c', ':', '1', '}']);
    expect(tokenizeConfig('# DEV_BYPASS_AUTH = 1\nx = "y" # z', true).map((t) => t.value)).toEqual([
      'x',
      '=',
      'y',
    ]);
  });

  it('catches JSON5 unquoted/single-quoted keys and TOML assignments', () => {
    const files = [
      { path: 'wrangler.json5', text: "{ vars: { DEV_BYPASS_AUTH: 'true' } }" },
      { path: 'a/wrangler.json5', text: "{ vars: { 'DEV_BYPASS_AUTH': 'true' } }" },
      { path: 'wrangler.toml', text: '[vars]\nDEV_BYPASS_AUTH = "true"\n' },
      { path: 'b/wrangler.toml', text: 'name = "x"\nvars.DEV_BYPASS_AUTH = "true"\n' },
    ];
    expect(evaluateForbiddenConfigKeys(files, forbiddenConfigKeys).map((v) => v.file)).toEqual([
      'a/wrangler.json5:1',
      'b/wrangler.toml:2',
      'wrangler.json5:1',
      'wrangler.toml:2',
    ]);
  });

  it('does not flag comment-only or value-only mentions', () => {
    const files = [
      { path: 'wrangler.toml', text: '# never set DEV_BYPASS_AUTH = true here\nname = "x"\n' },
      {
        path: 'wrangler.jsonc',
        text: '{ /* DEV_BYPASS_AUTH: true */ "note": "DEV_BYPASS_AUTH=1", // DEV_BYPASS_AUTH: 1\n}',
      },
      { path: 'wrangler.json5', text: "{ note: 'DEV_BYPASS_AUTH: true' }" },
    ];
    expect(evaluateForbiddenConfigKeys(files, forbiddenConfigKeys)).toEqual([]);
  });

  it('fails closed when no wrangler config matches the policy pattern', () => {
    const violations = evaluateForbiddenConfigKeys(
      [{ path: 'package.json', text: '{}' }],
      forbiddenConfigKeys
    );
    expect(violations).toEqual([
      expect.objectContaining({
        rule: 'forbidden-config-key',
        file: 'scripts/architecture.config.mts',
      }),
    ]);
    expect(violations[0]!.message).toContain('update forbiddenConfigKeys.filePattern');
  });

  it('fails DEV_BYPASS_AUTH set anywhere in a wrangler config, with the fix', () => {
    const violations = evaluateForbiddenConfigKeys(
      [
        {
          path: 'wrangler.jsonc',
          text: '{\n  // never set DEV_BYPASS_AUTH here\n  "env": { "staging": { "vars": {\n    "DEV_BYPASS_AUTH": "true" } } }\n}',
        },
        { path: 'echo/wrangler.json', text: '{ "vars": { "NOTE": "DEV_BYPASS_AUTH" } }' },
        { path: 'package.json', text: '{ "DEV_BYPASS_AUTH": "true" }' },
      ],
      forbiddenConfigKeys
    );
    expect(violations).toEqual([
      expect.objectContaining({ rule: 'forbidden-config-key', file: 'wrangler.jsonc:4' }),
    ]);
    expect(violations[0]!.message).toContain('.dev.vars');
  });

  it('scans wrangler configs below the root and holds on the real tree', () => {
    const root = tempRepo({
      'wrangler.jsonc': '{}',
      'echo/wrangler.toml': '',
      'echo/wrangler.jsonc': '{"vars":{"DEV_BYPASS_AUTH":"true"}}',
      'node_modules/pkg/wrangler.jsonc': '{"DEV_BYPASS_AUTH":"true"}',
    });
    expect(
      scanConfigFiles(root, forbiddenConfigKeys)
        .map((f) => f.path)
        .sort()
    ).toEqual(['echo/wrangler.jsonc', 'echo/wrangler.toml', 'wrangler.jsonc']);

    const real = scanConfigFiles(process.cwd(), forbiddenConfigKeys);
    expect(real.map((f) => f.path)).toContain('wrangler.jsonc');
    expect(evaluateForbiddenConfigKeys(real, forbiddenConfigKeys)).toEqual([]);
  });
});

describe('source pattern ratchets for invariants', () => {
  it('counts direct localStorage access in renderer and shared .ts/.tsx sources', () => {
    const name = 'direct localStorage access (renderer/shared)';
    const source = [
      'localStorage.setItem(k, v);',
      'window.localStorage.getItem(k);',
      'const s = globalThis.localStorage;',
      'localStorage[key] = v;',
      '// moved off plaintext localStorage.',
      'const localStorageKey = "x";',
    ].join('\n');
    expect(countSourcePatterns('src/a.tsx', source, architecturePolicy)?.[name]).toBe(4);
    expect(countSourcePatterns('shared/b.ts', source, architecturePolicy)?.[name]).toBe(4);
    expect(countSourcePatterns('src/a.test.ts', source, architecturePolicy)).toBeUndefined();
    expect(countSourcePatterns('worker/a.ts', source, architecturePolicy)).toBeUndefined();
  });

  it('counts inline ipcMain handlers but not createValidated* registrations', () => {
    const name = 'inline ipcMain handlers without a createValidated* wrapper';
    const source = `
      ipcMain.handle(IPC.log.clear, async (event) => {});
      ipcMain.handle(
        IPC.keychain.status,
        async (event): Promise<Status> => status()
      );
      ipcMain.on(IPC.window.close, (event) => close());
      ipcMain.handle(IPC.a.b, createValidatedHandler(IPC.a.b, Schema, run));
      ipcMain.handle(channel, rateLimited(limiter, createValidatedEventHandler(channel, s, h)));
    `;
    expect(countSourcePatterns('electron/main/x.ts', source, architecturePolicy)?.[name]).toBe(3);
  });
});

describe('runtime boundary invariants', () => {
  it('forbids Electron main and the CLI from importing the Worker or the renderer', () => {
    for (const from of ['electron-main', 'cli']) {
      for (const to of ['worker', 'renderer']) {
        expect(architecturePolicy.forbiddenDependencies).toContainEqual({ from, to });
      }
    }
    expect(
      evaluateArchitecture(
        [
          {
            path: 'electron/main/handlers/x.ts',
            imports: [
              { specifier: '../../../worker/app', resolvedPath: 'worker/app.ts', typeOnly: false },
            ],
            lineCount: 1,
          },
        ],
        architecturePolicy
      )
    ).toEqual([
      expect.objectContaining({
        rule: 'forbidden-dependency',
        message: 'electron-main must not depend on worker: ../../../worker/app',
      }),
    ]);
  });
});
