/**
 * Main-process safety net. Electron shows its raw crash dialog only when it
 * is the sole `uncaughtException` listener (`lib/browser/init.ts`). Installing
 * this handler suppresses that box. The failure is still logged and shown in
 * a short dialog that points at the log file.
 */

import { app, type BrowserWindow, dialog } from 'electron';
import electronLog from 'electron-log/main';
import {
  type FeatureFailure,
  featureFailureDialog,
  mainProcessErrorDialog,
} from './feature-loader';

export function isSmokeLaunch(): boolean {
  return process.env.RESTURA_SMOKE === '1';
}

export function logFilePath(): string {
  try {
    return electronLog.transports.file.getFile().path;
  } catch {
    return 'the Restura log';
  }
}

export interface ProcessGuardSink {
  error: (message: string, fields?: Record<string, unknown>) => void;
}

let uncaughtDialogShown = false;

export function installProcessGuards(log: ProcessGuardSink): void {
  process.on('uncaughtException', (err, origin) => {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error ? err.stack : undefined;
    log.error('uncaughtException', { origin, message, stack });
    if (isSmokeLaunch()) {
      console.error(`restura-smoke-failed uncaughtException ${message}`);
      app.exit(1);
      return;
    }
    if (uncaughtDialogShown) return;
    uncaughtDialogShown = true;
    const text = mainProcessErrorDialog(message, logFilePath());
    dialog.showErrorBox(text.title, text.body);
  });

  process.on('unhandledRejection', (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    log.error('unhandledRejection', { message, stack });
  });
}

/** One dialog for every feature that failed to load. Smoke runs stay quiet. */
export function reportFeatureFailures(failures: readonly FeatureFailure[]): void {
  if (failures.length === 0) return;
  const text = featureFailureDialog(failures, logFilePath());
  if (isSmokeLaunch()) {
    console.error(text.body);
    return;
  }
  dialog.showErrorBox(text.title, text.body);
}

/**
 * Pack smoke (`RESTURA_SMOKE=1`) exits 0 once the main frame has loaded, and
 * 1 if that load fails. The launcher treats any other exit as a hung start.
 */
export function watchSmokeWindow(win: BrowserWindow): void {
  if (!isSmokeLaunch()) return;
  let settled = false;
  const finish = (code: number, line: string) => {
    if (settled) return;
    settled = true;
    if (code === 0) console.log(line);
    else console.error(line);
    app.exit(code);
  };
  win.webContents.once('did-finish-load', () => {
    finish(0, 'restura-smoke-ready');
  });
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _url, isMainFrame) => {
    if (!isMainFrame) return;
    finish(1, `restura-smoke-failed ${errorCode} ${errorDescription}`);
  });
}
