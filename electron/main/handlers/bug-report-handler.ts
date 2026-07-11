import { app, clipboard, ipcMain, nativeImage, type BrowserWindow } from 'electron';
import { IPC } from '../../shared/channels';
import {
  BugReportScreenshotSchema,
  createValidatedHandler,
  NoInputSchema,
} from '../ipc/ipc-validators';
import { getRequestLogHistory } from '../lifecycle/request-logger';

export function registerBugReportIPC(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle(
    IPC.bugReport.captureScreenshot,
    createValidatedHandler(IPC.bugReport.captureScreenshot, NoInputSchema, async () => {
      const window = getMainWindow();
      if (!window || window.isDestroyed())
        return { ok: false as const, error: 'No Restura window is available.' };
      try {
        const image = await window.webContents.capturePage();
        const imageDataUrl = image.toDataURL();
        if (!imageDataUrl.startsWith('data:image/png;base64,')) {
          return { ok: false as const, error: 'The window screenshot was not a PNG.' };
        }
        return { ok: true as const, imageDataUrl };
      } catch (error) {
        return {
          ok: false as const,
          error: error instanceof Error ? error.message : 'Screenshot capture failed.',
        };
      }
    })
  );

  ipcMain.handle(
    IPC.bugReport.getDiagnostics,
    createValidatedHandler(IPC.bugReport.getDiagnostics, NoInputSchema, async () => {
      const window = getMainWindow();
      const requestLogs = await getRequestLogHistory(25);
      return {
        appVersion: app.getVersion(),
        platform: 'electron' as const,
        operatingSystem:
          process.platform === 'darwin'
            ? 'macOS'
            : process.platform === 'win32'
              ? 'Windows'
              : 'Linux',
        browser: `Electron ${process.versions.electron} (Chromium ${process.versions.chrome})`,
        route: window?.webContents.getURL() ?? '[unknown]',
        capturedAt: new Date().toISOString(),
        runtimeErrors: [],
        requestLogs: requestLogs.map((entry) => ({
          timestamp: new Date(entry.ts).toISOString(),
          protocol: entry.protocol,
          method: entry.method,
          url: entry.url,
          status: entry.status,
          durationMs: entry.durationMs,
          ...(entry.error ? { error: entry.error } : {}),
        })),
      };
    })
  );

  ipcMain.handle(
    IPC.bugReport.copyScreenshot,
    createValidatedHandler(
      IPC.bugReport.copyScreenshot,
      BugReportScreenshotSchema,
      (imageDataUrl) => {
        const image = nativeImage.createFromDataURL(imageDataUrl);
        if (image.isEmpty())
          return { ok: false as const, error: 'The screenshot could not be decoded.' };
        clipboard.writeImage(image);
        return { ok: true as const };
      }
    )
  );
}
