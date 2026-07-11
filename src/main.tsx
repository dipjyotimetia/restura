import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/globals.css';
// Side-effect import: registers built-in protocol modules with the
// singleton ProtocolRegistry before any React component mounts.
import '@/features/registry/bootstrap';
import { initNetworkPolicySync } from '@/lib/electron-network-policy';
import { initElectronSentry } from '@/lib/electron-sentry';
import { installBugReportErrorCapture } from '@/lib/shared/bug-report';
import { fetchFlags } from '@/lib/shared/feature-flags';
import { registerMigrationLogging } from '@/lib/shared/persistence/registerMigrationLogging';
import { installGlobalErrorHandlers } from '@/lib/shared/telemetry';

// Wire window.onerror + unhandledrejection so uncaught failures land in the
// telemetry sink (opt-out; gated on settings.telemetry.errorsEnabled).
installGlobalErrorHandlers();
installBugReportErrorCapture();
// Subscribe persisted-store migration outcomes to the logger before the stores
// finish their async rehydrate, so quarantined/lossy migrations are observable.
registerMigrationLogging();
// Electron-only: forward renderer crashes/errors to the main-process Sentry SDK
// over IPC (opt-out; no-op on web). Dynamically imported so the web bundle stays clean.
void initElectronSentry();
// Electron-only: push the Settings → Security outbound-network policy to main so
// every SSRF guard shares one policy (no-op on web).
initNetworkPolicySync();
// Kick off the feature-flag fetch immediately. UI uses `useFlag()` which
// re-renders when this resolves; default is fail-open so nothing is blocked.
void fetchFlags();

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root not found — index.html is missing the mount node');
}
ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
