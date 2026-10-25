import type { ForbiddenConfigKey } from './architecture-config-keys.mts';
import type { IpcTriplePolicy } from './architecture-ipc.mts';
import type { ArchitecturePolicy } from './architecture-policy.mts';

export const architecturePolicy: ArchitecturePolicy = {
  zones: [
    { name: 'shared', root: 'shared/' },
    { name: 'renderer', root: 'src/' },
    { name: 'worker', root: 'worker/' },
    { name: 'electron-main', root: 'electron/main/' },
    { name: 'electron-shared', root: 'electron/shared/' },
    { name: 'electron-types', root: 'electron/types/' },
    { name: 'cli', root: 'cli/src/' },
    { name: 'extensions', root: 'extension/' },
    { name: 'echo', root: 'echo/' },
    { name: 'echo-local', root: 'echo-local/' },
    { name: 'tooling', root: 'scripts/' },
  ],
  forbiddenDependencies: [
    { from: 'shared', to: 'renderer' },
    { from: 'shared', to: 'worker' },
    { from: 'shared', to: 'electron-main' },
    { from: 'shared', to: 'cli' },
    { from: 'shared', to: 'extensions' },
    { from: 'shared', to: 'electron-types' },
    { from: 'shared', to: 'echo' },
    { from: 'shared', to: 'echo-local' },
    { from: 'shared', to: 'tooling' },
    { from: 'worker', to: 'renderer' },
    { from: 'worker', to: 'electron-main' },
    // The Worker is never bundled into Electron or the CLI (CLAUDE.md invariant).
    { from: 'electron-main', to: 'worker' },
    { from: 'cli', to: 'worker' },
    { from: 'renderer', to: 'worker' },
    { from: 'renderer', to: 'electron-main' },
    { from: 'electron-main', to: 'renderer' },
    { from: 'electron-shared', to: 'renderer' },
    { from: 'electron-shared', to: 'worker' },
    { from: 'electron-shared', to: 'electron-main' },
    { from: 'electron-shared', to: 'electron-types' },
    { from: 'electron-shared', to: 'cli' },
    { from: 'electron-shared', to: 'extensions' },
    { from: 'electron-shared', to: 'echo' },
    { from: 'electron-shared', to: 'echo-local' },
    { from: 'electron-shared', to: 'tooling' },
    { from: 'electron-types', to: 'renderer' },
    { from: 'electron-types', to: 'worker' },
    { from: 'electron-types', to: 'electron-main' },
    { from: 'electron-types', to: 'cli' },
    { from: 'electron-types', to: 'extensions' },
    { from: 'cli', to: 'renderer' },
    { from: 'extensions', to: 'renderer' },
    { from: 'echo', to: 'renderer' },
    { from: 'echo-local', to: 'renderer' },
  ],
  allowedDependencies: [],
  maxNewProductionFileLines: 800,
  grandfatheredFileLines: {
    'shared/scripts/script-executor.ts': 1_194,
    'electron/main/handlers/http-handler.ts': 861,
    'electron/main/handlers/kafka-handler.ts': 670,
    'electron/main/ipc/validators/kafka.ts': 1007,
    'electron/main/handlers/grpc-connect.ts': 816,
  },
  // Type scale (UI/UX Phase 6): sizes come from the text-sp-* tokens, 11px
  // minimum. Both counts may only go down.
  sourcePatternRatchets: [
    {
      name: 'arbitrary pixel font sizes (text-[Npx])',
      pathPrefix: 'src/',
      extension: '.tsx',
      pattern: String.raw`\btext-\[\d+(?:\.\d+)?px\]`,
      max: 85,
    },
    {
      name: 'sub-11px type tokens (text-sp-9 / text-sp-10 / text-sp-10-5)',
      pathPrefix: 'src/',
      extension: '.tsx',
      pattern: String.raw`\btext-sp-(?:9|10)(?:-5)?\b`,
      max: 93,
    },
    // CLAUDE.md "Secrets": no new persistence through window.localStorage —
    // stores persist via Dexie (web) / encrypted electron-store (desktop).
    // Counts direct member/index access and `window.`/`globalThis.` value
    // references (comments included, so the cap is stable); may only go down.
    {
      name: 'direct localStorage access (renderer/shared)',
      pathPrefix: ['src/', 'shared/'],
      extension: ['.ts', '.tsx'],
      pattern: String.raw`\b(?:window|globalThis|self)\.localStorage\b|\blocalStorage\s*(?:\??\.(?=[A-Za-z_$])|\[)`,
      max: 11,
      hint: 'persist through a Dexie-backed store (web) / secureStorage → encrypted electron-store (desktop), validated by Zod',
    },
    // CLAUDE.md "Electron main": IPC input is validated by a Zod schema via
    // createValidatedHandler / createValidatedListener. Counts handlers
    // registered as an inline function (no validating wrapper); may only go down.
    {
      name: 'inline ipcMain handlers without a createValidated* wrapper',
      pathPrefix: 'electron/main/',
      extension: '.ts',
      pattern: String.raw`\bipcMain\.(?:handle|on)\(\s*[\w.]+,\s*(?:async\s+)?(?:function\b|\([^()]*\)\s*(?::[^=]*)?=>|\w+\s*=>)`,
      max: 22,
      hint: 'wrap the handler in createValidatedHandler/createValidatedListener with a Zod schema from electron/main/ipc/validators/',
    },
  ],
};

/**
 * IPC triple (CLAUDE.md "Electron main"): every channel in the IPC registry
 * must be handled in Electron main and exposed by the preload bridge, and the
 * preload bridge must stay typed against ElectronAPI. Exceptions need a reason.
 */
export const ipcTriplePolicy: IpcTriplePolicy = {
  registryDir: 'electron/shared/channels/',
  mainRoot: 'electron/main/',
  preloadEntry: 'electron/main/preload.ts',
  preloadDir: 'electron/main/preload/',
  mainOnlyChannels: {},
  preloadOnlyChannels: {},
};

export const forbiddenConfigKeys: ForbiddenConfigKey[] = [
  {
    key: 'DEV_BYPASS_AUTH',
    filePattern: String.raw`(?:^|/)wrangler[^/]*\.json[c5]?$`,
    reason:
      'it disables Worker auth for every deployed request. Remove it — set DEV_BYPASS_AUTH=true only in the gitignored .dev.vars for local dev; production needs WORKER_PROXY_TOKEN or REQUIRE_CF_ACCESS=true',
  },
];
