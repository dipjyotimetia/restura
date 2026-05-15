import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/globals.css';
// Side-effect import: registers built-in protocol modules with the
// singleton ProtocolRegistry before any React component mounts.
import '@/features/registry/bootstrap';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
