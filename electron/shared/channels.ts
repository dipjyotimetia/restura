// Single source of truth for IPC channel names shared between the Electron
// main process (handlers in electron/main/*) and the preload bridge
// (electron/main/preload.ts). Both sides import from here so renaming a
// channel is a compile error rather than a silent runtime break.
//
// - IPC: request/response (`ipcMain.handle`) and fire-and-forget
//   (`ipcMain.on`) channels invoked by the renderer.
// - EVENT: static main→renderer push channels.
// - EVENT_PREFIX + eventChannel(): templated per-connection main→renderer
//   channels (e.g. `grpc:data:<requestId>`).
// - CHANNEL_PREFIXES: the namespace allowlist enforced by preload's event
//   bridge (`channel.startsWith(prefix)`). This is a security boundary —
//   keep it here so the guard is defined once, not copy-pasted per protocol.

export const IPC = {
  app: {
    checkForUpdates: 'app:checkForUpdates',
    getPath: 'app:getPath',
    getVersion: 'app:getVersion',
  },
  dialog: {
    openFile: 'dialog:openFile',
    saveFile: 'dialog:saveFile',
  },
  fs: {
    readFile: 'fs:readFile',
    writeFile: 'fs:writeFile',
  },
  shell: {
    openExternal: 'shell:openExternal',
  },
  window: {
    minimize: 'window:minimize',
    maximize: 'window:maximize',
    close: 'window:close',
    new: 'window:new',
  },
  http: {
    request: 'http:request',
  },
  grpc: {
    request: 'grpc:request',
    reflect: 'grpc:reflect',
    startStream: 'grpc:start-stream',
    sendMessage: 'grpc:send-message',
    endStream: 'grpc:end-stream',
    cancelStream: 'grpc:cancel-stream',
  },
  ws: {
    connect: 'ws:connect',
    send: 'ws:send',
    disconnect: 'ws:disconnect',
  },
  socketio: {
    connect: 'socketio:connect',
    emit: 'socketio:emit',
    disconnect: 'socketio:disconnect',
  },
  sse: {
    connect: 'sse:connect',
    disconnect: 'sse:disconnect',
  },
  mcp: {
    connect: 'mcp:connect',
    request: 'mcp:request',
    disconnect: 'mcp:disconnect',
  },
  kafka: {
    connect: 'kafka:connect',
    produce: 'kafka:produce',
    subscribe: 'kafka:subscribe',
    unsubscribe: 'kafka:unsubscribe',
    disconnect: 'kafka:disconnect',
  },
  notification: {
    isSupported: 'notification:isSupported',
    show: 'notification:show',
    requestComplete: 'notification:requestComplete',
    updateAvailable: 'notification:updateAvailable',
    error: 'notification:error',
  },
  store: {
    get: 'store:get',
    set: 'store:set',
    delete: 'store:delete',
    clear: 'store:clear',
    has: 'store:has',
  },
  secret: {
    store: 'secret:store',
    delete: 'secret:delete',
    describe: 'secret:describe',
    list: 'secret:list',
  },
  git: {
    status: 'git:status',
    log: 'git:log',
    diff: 'git:diff',
    branchList: 'git:branch:list',
    add: 'git:add',
    commit: 'git:commit',
    createBranch: 'git:branch:create',
    checkoutBranch: 'git:branch:checkout',
  },
  log: {
    getHistory: 'log:getHistory',
    clear: 'log:clear',
  },
  keychain: {
    status: 'keychain:status',
    rotate: 'keychain:rotate',
  },
  collection: {
    loadDirectory: 'collection:load-directory',
    saveDirectory: 'collection:save-directory',
    watch: 'collection:watch',
    unwatch: 'collection:unwatch',
    selectDirectory: 'collection:select-directory',
    openInExplorer: 'collection:open-in-explorer',
    getFileInfo: 'collection:get-file-info',
  },
  ai: {
    chat: 'ai:chat',
    chatCancel: 'ai:chat:cancel',
  },
  mock: {
    start: 'mock:start',
    stop: 'mock:stop',
    status: 'mock:status',
  },
} as const;

/** Static main→renderer push channels (not per-connection). */
export const EVENT = {
  collectionFileChanged: 'collection:file-changed',
} as const;

/**
 * Prefixes for templated per-connection main→renderer channels. Combine with
 * a connection/request/stream id via {@link eventChannel}.
 */
export const EVENT_PREFIX = {
  grpc: {
    data: 'grpc:data:',
    error: 'grpc:error:',
    status: 'grpc:status:',
  },
  ws: {
    open: 'ws:open:',
    message: 'ws:message:',
    error: 'ws:error:',
    close: 'ws:close:',
  },
  // Socket.IO event channels are NOT defined here. They have a pre-existing
  // single source of truth in `shared/socketio-constants.ts` (`socketioChannels`),
  // shared by the renderer's socketioManager and the Electron handler. Don't
  // duplicate them — the actual names use snake_case (`reconnect_attempt`).
  sse: {
    open: 'sse:open:',
    event: 'sse:event:',
    error: 'sse:error:',
    close: 'sse:close:',
  },
  mcp: {
    open: 'mcp:open:',
    notification: 'mcp:notification:',
    error: 'mcp:error:',
    close: 'mcp:close:',
  },
  kafka: {
    connected: 'kafka:connected:',
    message: 'kafka:message:',
    error: 'kafka:error:',
    consumerClosed: 'kafka:consumer-closed:',
    close: 'kafka:close:',
  },
  ai: {
    chunk: 'ai:chat:chunk:',
    end: 'ai:chat:end:',
  },
} as const;

/** Build a templated event channel: `eventChannel('grpc:data:', id)`. */
export function eventChannel(prefix: string, id: string | number): string {
  return `${prefix}${id}`;
}

/**
 * Namespace prefixes preload's event bridge allowlists. A renderer may only
 * subscribe to channels under one of these prefixes — the guard lives here so
 * a typo can't silently weaken isolation for one protocol.
 */
export const CHANNEL_PREFIXES = {
  grpc: 'grpc:',
  ws: 'ws:',
  socketio: 'socketio:',
  sse: 'sse:',
  mcp: 'mcp:',
  kafka: 'kafka:',
} as const;

/**
 * Top-level menu/app event channels the renderer may subscribe to via the
 * generic `window.electron.on(...)` bridge.
 */
export const VALID_EVENT_CHANNELS = [
  'menu:import',
  'menu:export',
  'menu:new-request',
  'app:focus',
  'deep-link',
] as const;

/** Flat list of every static `ipcMain.handle` / `ipcMain.on` channel. */
export const ALL_IPC_CHANNELS: readonly string[] = Object.values(IPC).flatMap((group) =>
  Object.values(group)
);
