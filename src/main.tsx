import React from 'react';
import ReactDOM from 'react-dom/client';
import { Buffer } from 'buffer';
import App from './App';
import './styles/globals.css';

// Browser polyfill for Node's `Buffer` global. swagger-parser (used by the
// OpenAPI importer) calls `Buffer.from(...)` during dereference; without this
// shim the import fails with "Buffer is not defined" in the renderer. Runs
// before any feature module that might dynamically import swagger-parser.
if (typeof globalThis !== 'undefined' && !('Buffer' in globalThis)) {
  (globalThis as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;
}
// Side-effect import: registers built-in protocol modules with the
// singleton ProtocolRegistry before any React component mounts.
import '@/features/registry/bootstrap';
import { installGlobalErrorHandlers } from '@/lib/shared/telemetry';
import { fetchFlags } from '@/lib/shared/feature-flags';

// Wire window.onerror + unhandledrejection so uncaught failures land in the
// opt-in telemetry sink (off by default; gated on settings.telemetry.errorsEnabled).
installGlobalErrorHandlers();
// Kick off the feature-flag fetch immediately. UI uses `useFlag()` which
// re-renders when this resolves; default is fail-open so nothing is blocked.
void fetchFlags();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
