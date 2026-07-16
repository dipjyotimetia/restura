export interface ElectronDialogAPI {
  openFile: (options?: {
    title?: string;
    defaultPath?: string;
    filters?: Array<{ name: string; extensions: string[] }>;
    properties?: Array<'openFile' | 'openDirectory' | 'multiSelections'>;
  }) => Promise<{
    canceled: boolean;
    filePaths: string[];
  }>;

  saveFile: (options?: {
    title?: string;
    defaultPath?: string;
    filters?: Array<{ name: string; extensions: string[] }>;
  }) => Promise<{
    canceled: boolean;
    filePath?: string;
  }>;
}

export interface ElectronFSAPI {
  readFile: (filePath: string) => Promise<{
    success: boolean;
    content?: string;
    error?: string;
  }>;

  writeFile: (
    filePath: string,
    content: string
  ) => Promise<{
    success: boolean;
    error?: string;
  }>;
}

export interface ElectronAppAPI {
  // Keep in sync with AppPathNameSchema in electron/main/ipc/ipc-validators.ts.
  getPath: (
    name:
      | 'home'
      | 'appData'
      | 'userData'
      | 'sessionData'
      | 'cache'
      | 'temp'
      | 'exe'
      | 'module'
      | 'desktop'
      | 'documents'
      | 'downloads'
      | 'music'
      | 'pictures'
      | 'videos'
      | 'recent'
      | 'logs'
      | 'crashDumps'
  ) => Promise<string>;
  getVersion: () => Promise<string>;
  checkForUpdates: () => Promise<{
    updateAvailable: boolean;
    version?: string;
    message?: string;
    error?: string;
  }>;
}

export interface ElectronShellAPI {
  openExternal: (url: string) => Promise<void>;
}

/**
 * Auto-updater state pushed main→renderer over EVENT.updaterStatus. Single
 * discriminated shape keyed on `state` — maps to one renderer state machine.
 */
export type UpdaterErrorPhase = 'check' | 'download' | 'validation' | 'install';

export interface UpdaterStatus {
  state:
    | 'idle'
    | 'checking'
    | 'not-available'
    | 'available'
    | 'downloading'
    | 'validating'
    | 'downloaded'
    | 'installing'
    | 'error';
  /** Present while an update version is known. */
  version?: string;
  /** Download completion 0–100, present for `downloading`. */
  percent?: number;
  /** Human-readable detail for `error` / `not-available`. */
  message?: string;
  /** Safe lifecycle classification for `error`. */
  phase?: UpdaterErrorPhase;
}

export interface ElectronUpdaterAPI {
  check: () => Promise<{
    updateAvailable: boolean;
    version?: string;
    message?: string;
    error?: string;
  }>;
  getStatus: () => Promise<UpdaterStatus>;
  download: () => Promise<{ ok: boolean; error?: string }>;
  cancel: () => Promise<{ ok: boolean }>;
  restart: () => Promise<void>;
  setConfig: (config: { autoDownload: boolean; channel: 'stable' | 'beta' }) => Promise<void>;
  /** Subscribe to status pushes; returns an unsubscribe fn (mirrors ai.onChunk). */
  onStatus: (callback: (status: UpdaterStatus) => void) => () => void;
}

export interface ElectronWindowAPI {
  minimize: () => void;
  maximize: () => void;
  close: () => void;
  openNew: () => Promise<void>;
}
