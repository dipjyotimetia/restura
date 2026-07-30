import { type DeepLinkPayload, parseDeepLink } from '@shared/deep-link';
import type { BrowserWindow, WebContents } from 'electron';
import { app, ipcMain } from 'electron';
import * as path from 'path';
import { z } from 'zod';
import { EVENT, IPC } from '../../shared/channels';
import { createValidatedEventHandler, NoInputSchema } from '../ipc/ipc-validators';

const AcknowledgeSchema = z.object({ id: z.string().min(1).max(128) }).strict();
const MAX_PENDING_DEEP_LINKS = 32;

/**
 * Holds OS links until the preload listener is installed. A payload remains at
 * the front of the queue until the renderer acknowledges it, so a renderer
 * reload cannot silently lose a link between delivery and React hydration.
 */
export class DeepLinkController {
  private pending: DeepLinkPayload[] = [];
  private fingerprints = new Set<string>();
  private readySender: WebContents | null = null;
  private nextId = 1;

  receive(url: string): void {
    const action = parseDeepLink(url);
    if (!action || this.pending.length >= MAX_PENDING_DEEP_LINKS) return;
    const fingerprint = JSON.stringify(action);
    if (this.fingerprints.has(fingerprint)) return;
    const payload = { ...action, id: `deep-link-${this.nextId++}` } as DeepLinkPayload;
    this.pending.push(payload);
    this.fingerprints.add(fingerprint);
    this.flush();
  }

  ready(sender: WebContents): void {
    this.readySender = sender;
    sender.once('destroyed', () => {
      if (this.readySender?.id === sender.id) this.readySender = null;
    });
    this.flush();
  }

  acknowledge(sender: WebContents, id: string): void {
    if (this.readySender?.id !== sender.id || this.pending[0]?.id !== id) return;
    const delivered = this.pending.shift();
    if (delivered) this.fingerprints.delete(JSON.stringify(withoutId(delivered)));
    this.flush();
  }

  private flush(): void {
    const next = this.pending[0];
    if (!next || !this.readySender || this.readySender.isDestroyed()) return;
    this.readySender.send(EVENT.deepLink, next);
  }
}

function withoutId(payload: DeepLinkPayload) {
  const { id: _id, ...action } = payload;
  return action;
}

export function registerDeepLinkHandler(getWindow: () => BrowserWindow | null): DeepLinkController {
  const controller = new DeepLinkController();
  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('restura', process.execPath, [path.resolve(process.argv[1]!)]);
  } else {
    app.setAsDefaultProtocolClient('restura');
  }

  const receiveAndFocus = (url: string) => {
    controller.receive(url);
    const win = getWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  };

  // Windows/Linux cold starts receive the protocol URL as an argv entry before
  // any BrowserWindow or renderer exists; enqueue it now for the first ready.
  for (const arg of process.argv) if (arg.startsWith('restura://')) controller.receive(arg);

  app.on('open-url', (event, url) => {
    event.preventDefault();
    receiveAndFocus(url);
  });
  app.on('second-instance', (_event, argv) => {
    for (const arg of argv) if (arg.startsWith('restura://')) receiveAndFocus(arg);
  });

  ipcMain.handle(
    IPC.deepLink.ready,
    createValidatedEventHandler(IPC.deepLink.ready, NoInputSchema, (_input, event) => {
      controller.ready(event.sender);
      return { ok: true as const };
    })
  );
  ipcMain.handle(
    IPC.deepLink.acknowledge,
    createValidatedEventHandler(IPC.deepLink.acknowledge, AcknowledgeSchema, ({ id }, event) => {
      controller.acknowledge(event.sender, id);
      return { ok: true as const };
    })
  );
  return controller;
}

// Test seam: tests exercise the same parser and acknowledgement queue as OS events.
export const __test_parseDeepLink = parseDeepLink;
