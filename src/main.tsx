import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/globals.css';
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
