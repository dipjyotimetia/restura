import { vi } from 'vitest';

// Side-effecting electron mock that legacy tests `import './setup'` to register
// (sentry/logging/grpc-handler rely on this registration so the real `electron`
// binary never loads). Delegates to the shared factory so the two mocks can't
// drift. New tests should mock electron directly:
//   vi.mock('electron', () => createElectronMock())  // from ./helpers/electron-mock
vi.mock('electron', async () => {
  // `.js` specifier satisfies nodenext's extension rule for dynamic imports;
  // Vitest resolves it back to the .ts source at runtime.
  const { createElectronMock } = await import('./helpers/electron-mock.js');
  return createElectronMock();
});
