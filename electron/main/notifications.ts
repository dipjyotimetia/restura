import { Notification, ipcMain, BrowserWindow, app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import {
  NotificationOptionsSchema,
  NotificationRequestCompleteSchema,
  NotificationVersionSchema,
  NotificationMessageSchema,
  createValidatedHandler,
} from './ipc-validators';

function getResourcePath(resource: string, isDev: boolean): string {
  if (isDev) {
    return path.join(__dirname, '../../../electron/resources', resource);
  } else {
    return path.join(app.getAppPath(), 'electron/resources', resource);
  }
}

function getIconPath(isDev: boolean): string | undefined {
  const iconPath = getResourcePath('icon.png', isDev);
  if (fs.existsSync(iconPath)) {
    return iconPath;
  }
  return undefined;
}

interface NotificationOptions {
  title: string;
  body: string;
  silent?: boolean;
  urgency?: 'normal' | 'critical' | 'low';
}

export function showNativeNotification(
  options: NotificationOptions,
  mainWindow: BrowserWindow | null,
  isDev: boolean
): void {
  const iconPath = getIconPath(isDev);

  const notification = new Notification({
    title: options.title,
    body: options.body,
    icon: iconPath,
    silent: options.silent ?? false,
    urgency: options.urgency ?? 'normal',
  });

  notification.on('click', () => {
    // Show and focus the main window when notification is clicked
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  notification.show();
}

export function registerNotificationIPC(getMainWindow: () => BrowserWindow | null, isDev: boolean): void {
  // Check if notifications are supported
  ipcMain.handle('notification:isSupported', () => {
    return Notification.isSupported();
  });

  // Show a native notification
  ipcMain.handle(
    'notification:show',
    createValidatedHandler('notification:show', NotificationOptionsSchema, async (options: NotificationOptions) => {
      const mainWindow = getMainWindow();
      showNativeNotification(options, mainWindow, isDev);
      return { success: true };
    })
  );

  // Show request completed notification
  ipcMain.handle(
    'notification:requestComplete',
    createValidatedHandler(
      'notification:requestComplete',
      NotificationRequestCompleteSchema,
      async (data: { status: number; time: number; url: string }) => {
        const mainWindow = getMainWindow();
        const statusEmoji = data.status >= 200 && data.status < 300 ? '✅' : '❌';
        showNativeNotification(
          {
            title: `${statusEmoji} Request Complete`,
            body: `Status: ${data.status} | Time: ${data.time}ms\n${data.url}`,
            urgency: data.status >= 400 ? 'critical' : 'normal',
          },
          mainWindow,
          isDev
        );
        return { success: true };
      }
    )
  );

  // Show update available notification
  ipcMain.handle(
    'notification:updateAvailable',
    createValidatedHandler('notification:updateAvailable', NotificationVersionSchema, async (version: string) => {
      const mainWindow = getMainWindow();
      showNativeNotification(
        {
          title: '🚀 Update Available',
          body: `Version ${version} is available for download`,
          urgency: 'normal',
        },
        mainWindow,
        isDev
      );
      return { success: true };
    })
  );

  // Show error notification
  ipcMain.handle(
    'notification:error',
    createValidatedHandler('notification:error', NotificationMessageSchema, async (message: string) => {
      const mainWindow = getMainWindow();
      showNativeNotification(
        {
          title: '⚠️ Error',
          body: message,
          urgency: 'critical',
        },
        mainWindow,
        isDev
      );
      return { success: true };
    })
  );
}
