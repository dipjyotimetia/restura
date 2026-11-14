/**
 * Desktop IPC features, loaded when they register rather than when main.js
 * is evaluated. A missing or broken optional stack throws inside `start`,
 * which the feature loader catches, so the window still opens.
 */

import type { BrowserWindow } from 'electron';
import type { StartupFeature } from './feature-loader';
import type { LogEntry } from './request-logger';

export interface DesktopFeatureDeps {
  isDev: boolean;
  getMainWindow: () => BrowserWindow | null;
  logRequest: (entry: LogEntry) => void;
}

export function createDesktopFeatures(deps: DesktopFeatureDeps): StartupFeature[] {
  const { isDev, getMainWindow, logRequest } = deps;
  return [
    feature('deep-link-import', () => {
      const m =
        require('../handlers/deep-link-import-handler') as typeof import('../handlers/deep-link-import-handler');
      m.registerDeepLinkImportIPC();
    }),
    feature('auto-updater', () => {
      const m = require('./auto-updater') as typeof import('./auto-updater');
      m.registerAutoUpdaterIPC(isDev);
    }),
    feature('file-operations', () => {
      const m =
        require('../storage/file-operations') as typeof import('../storage/file-operations');
      m.registerFileOperationsIPC(getMainWindow);
    }),
    feature('bruno-export', () => {
      const m =
        require('../storage/bruno-export-handler') as typeof import('../storage/bruno-export-handler');
      m.registerBrunoExportHandlerIPC();
      return () => m.disposeBrunoExportHandlerIPC();
    }),
    feature('http', () => {
      const m = require('../handlers/http-handler') as typeof import('../handlers/http-handler');
      m.registerHttpHandlerIPC(logRequest);
    }),
    feature('grpc', () => {
      const m = require('../handlers/grpc-handler') as typeof import('../handlers/grpc-handler');
      m.registerGrpcHandlerIPC(logRequest);
      return () => m.stopStreamCleanup();
    }),
    feature('grpc-reflection', () => {
      const m =
        require('../handlers/grpc-reflection-handler') as typeof import('../handlers/grpc-reflection-handler');
      m.registerGrpcReflectionIPC();
    }),
    feature('websocket', () => {
      const m =
        require('../handlers/websocket-handler') as typeof import('../handlers/websocket-handler');
      m.registerWebSocketHandlerIPC();
      return () => m.stopWebSocketCleanup();
    }),
    feature('socketio', () => {
      const m =
        require('../handlers/socketio-handler') as typeof import('../handlers/socketio-handler');
      m.registerSocketIoHandlerIPC();
      return () => m.stopSocketIoCleanup();
    }),
    feature('sse', () => {
      const m = require('../handlers/sse-handler') as typeof import('../handlers/sse-handler');
      m.registerSseHandlerIPC();
      return () => m.stopSseCleanup();
    }),
    feature('mcp', () => {
      const m = require('../handlers/mcp-handler') as typeof import('../handlers/mcp-handler');
      m.registerMcpHandlerIPC();
      return () => m.stopMcpCleanup();
    }),
    feature('mcp-import', () => {
      const m =
        require('../handlers/mcp-import-handler') as typeof import('../handlers/mcp-import-handler');
      m.registerMcpImportIPC(getMainWindow);
      return () => m.unregisterMcpImportIPC();
    }),
    feature('mcp-conformance', () => {
      const m =
        require('../handlers/mcp-conformance-handler') as typeof import('../handlers/mcp-conformance-handler');
      m.registerMcpConformanceIPC();
      return () => m.stopMcpConformanceCleanup();
    }),
    feature('kafka', () => {
      const m = require('../handlers/kafka-handler') as typeof import('../handlers/kafka-handler');
      m.registerKafkaHandlerIPC(logRequest);
      return () => m.stopKafkaCleanup();
    }),
    feature('mqtt', () => {
      const m = require('../handlers/mqtt-handler') as typeof import('../handlers/mqtt-handler');
      m.registerMqttHandlerIPC(logRequest);
      return () => m.stopMqttCleanup();
    }),
    feature('request-logger', () => {
      const m = require('./request-logger') as typeof import('./request-logger');
      m.registerRequestLoggerIPC();
    }),
    feature('window-controls', () => {
      const m = require('./window-controls') as typeof import('./window-controls');
      m.registerWindowControlsIPC(getMainWindow);
    }),
    feature('new-window', () => {
      const m = require('../window-manager') as typeof import('../window-manager');
      m.registerNewWindowIPC(isDev);
    }),
    feature('notifications', () => {
      const m = require('../notifications') as typeof import('../notifications');
      m.registerNotificationIPC(getMainWindow, isDev);
    }),
    feature('collections', () => {
      const m =
        require('../storage/collection-manager') as typeof import('../storage/collection-manager');
      m.registerCollectionManagerIPC(getMainWindow);
      return () => m.cleanupCollectionWatchers();
    }),
    feature('ows-workspace', () => {
      const m =
        require('../handlers/ows-workspace-handler') as typeof import('../handlers/ows-workspace-handler');
      m.registerOwsWorkspaceHandlerIPC();
    }),
    feature('store', () => {
      const m = require('../storage/store-handler') as typeof import('../storage/store-handler');
      m.registerStoreHandlerIPC();
    }),
    feature('secret-handles', () => {
      const m =
        require('../security/secret-handle-store') as typeof import('../security/secret-handle-store');
      m.registerSecretHandleIPC();
      return () => m.unregisterSecretHandleIPC();
    }),
    feature('external-secrets', () => {
      const m =
        require('../security/external-secret-profile-store') as typeof import('../security/external-secret-profile-store');
      m.registerExternalSecretProfileIPC();
      return () => m.unregisterExternalSecretProfileIPC();
    }),
    feature('vault', () => {
      const m = require('../storage/vault-handler') as typeof import('../storage/vault-handler');
      m.registerVaultHandlers();
      return () => m.unregisterVaultHandlers();
    }),
    feature('keychain-status', () => {
      const m =
        require('../security/keychain-status-handler') as typeof import('../security/keychain-status-handler');
      m.registerKeychainStatusIPC();
    }),
    feature('git', () => {
      const collections =
        require('../storage/collection-manager') as typeof import('../storage/collection-manager');
      const git = require('../handlers/git-handler') as typeof import('../handlers/git-handler');
      git.setGitDirectoryAllowlist(collections.isRegisteredCollectionDirectory);
      git.registerGitHandlerIPC();
    }),
    feature('telemetry-consent', () => {
      const m = require('./telemetry-consent') as typeof import('./telemetry-consent');
      m.registerTelemetryConsentIPC();
    }),
    feature('execution-policy', () => {
      const m =
        require('../security/execution-policy') as typeof import('../security/execution-policy');
      m.registerExecutionPolicyIPC();
    }),
    feature('bug-report', () => {
      const m =
        require('../handlers/bug-report-handler') as typeof import('../handlers/bug-report-handler');
      m.registerBugReportIPC(getMainWindow);
    }),
    feature('ai', () => {
      const m = require('../handlers/ai-handler') as typeof import('../handlers/ai-handler');
      m.registerAiHandlers();
      return () => m.unregisterAiHandlers();
    }),
    feature('ai-lab', () => {
      const m =
        require('../handlers/ai-lab-handler') as typeof import('../handlers/ai-lab-handler');
      m.registerAiLabHandlers();
      return () => m.unregisterAiLabHandlers();
    }),
    feature('mock-server', () => {
      const m =
        require('../handlers/mock-server-handler') as typeof import('../handlers/mock-server-handler');
      m.registerMockServerIPC();
      return async () => {
        await m.stopMockServer();
        m.unregisterMockServerIPC();
      };
    }),
    feature('capture-bridge', () => {
      const m =
        require('../handlers/capture-bridge-handler') as typeof import('../handlers/capture-bridge-handler');
      m.registerCaptureBridgeIPC(getMainWindow);
      return async () => {
        await m.stopCaptureBridge();
        m.unregisterCaptureBridgeIPC();
      };
    }),
    feature('mcp-control', () => {
      const m =
        require('../handlers/mcp-control-handler') as typeof import('../handlers/mcp-control-handler');
      m.registerMcpControlIPC();
      return () => m.disposeMcpControlIPC();
    }),
  ];
}

function feature(name: string, start: StartupFeature['start']): StartupFeature {
  return { name, start };
}
