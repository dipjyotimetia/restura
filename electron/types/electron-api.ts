// Canonical renderer-facing Electron API, composed from domain-owned type modules.
// The preload object must satisfy this interface, so IPC surface drift remains a
// compile-time error in both the renderer and Electron main projects.

import type {
  ElectronAiAPI,
  ElectronAiLabAPI,
  ElectronBugReportAPI,
  ElectronCaptureAPI,
  ElectronCollectionsAPI,
  ElectronGitAPI,
  ElectronKeychainAPI,
  ElectronLogAPI,
  ElectronMockAPI,
  ElectronNotificationAPI,
  ElectronOwsWorkspaceAPI,
  ElectronSecretsAPI,
  ElectronSecurityAPI,
  ElectronStoreAPI,
  ElectronTelemetryAPI,
  ElectronVaultAPI,
} from './api/integrations';
import type {
  ElectronAppAPI,
  ElectronDialogAPI,
  ElectronFSAPI,
  ElectronShellAPI,
  ElectronUpdaterAPI,
  ElectronWindowAPI,
} from './api/platform';
import type {
  ElectronGrpcAPI,
  ElectronHttpAPI,
  ElectronKafkaAPI,
  ElectronMcpAPI,
  ElectronMqttAPI,
  ElectronSocketIoAPI,
  ElectronSseAPI,
  ElectronWebSocketAPI,
} from './api/protocols';

export interface ElectronAPI {
  platform: NodeJS.Platform;
  isElectron: boolean;
  dialog: ElectronDialogAPI;
  fs: ElectronFSAPI;
  app: ElectronAppAPI;
  updater: ElectronUpdaterAPI;
  shell: ElectronShellAPI;
  window: ElectronWindowAPI;
  http: ElectronHttpAPI;
  grpc: ElectronGrpcAPI;
  websocket: ElectronWebSocketAPI;
  socketio: ElectronSocketIoAPI;
  sse: ElectronSseAPI;
  mcp: ElectronMcpAPI;
  kafka: ElectronKafkaAPI;
  mqtt: ElectronMqttAPI;
  notification: ElectronNotificationAPI;
  store: ElectronStoreAPI;
  git: ElectronGitAPI;
  mock: ElectronMockAPI;
  capture: ElectronCaptureAPI;
  secrets: ElectronSecretsAPI;
  vault: ElectronVaultAPI;
  ai: ElectronAiAPI;
  aiLab: ElectronAiLabAPI;
  log: ElectronLogAPI;
  keychain: ElectronKeychainAPI;
  collections: ElectronCollectionsAPI;
  owsWorkspace: ElectronOwsWorkspaceAPI;
  bugReport: ElectronBugReportAPI;
  telemetry: ElectronTelemetryAPI;
  security: ElectronSecurityAPI;
  on: (channel: string, callback: (...args: unknown[]) => void) => void;
  removeListener: (channel: string, callback: (...args: unknown[]) => void) => void;
}

declare global {
  interface Window {
    electron?: ElectronAPI;
  }
}

export * from './api/integrations';
export * from './api/platform';
export * from './api/protocols';
