import { executeHttpProxy } from '@shared/protocol/http-proxy';
import { validateURL } from '@shared/protocol/url-validation';
import { ipcMain } from 'electron';
import { z } from 'zod';
import { IPC } from '../../shared/channels';
import { createValidatedHandler } from '../ipc/ipc-validators';
import { makePinnedFetcher } from './fetch-fetcher';

const ImportUrlSchema = z.object({ url: z.string().min(1).max(4096) }).strict();

/** Confirmation-gated downloader for a reviewed deep-link import. */
export function registerDeepLinkImportIPC(): void {
  ipcMain.handle(
    IPC.deepLink.fetchImport,
    createValidatedHandler(IPC.deepLink.fetchImport, ImportUrlSchema, async ({ url }) => {
      const policy = validateURL(url, {
        allowedSchemes: ['http:', 'https:'],
        allowLocalhost: false,
        allowPrivateIPs: false,
      });
      if (!policy.valid) return { ok: false as const, error: 'The import URL is not allowed.' };
      try {
        if (new URL(url).username || new URL(url).password)
          return { ok: false as const, error: 'Import URLs cannot contain credentials.' };
        // Resolve and pin each redirect hop separately: executeHttpProxy owns
        // redirect policy while this adapter closes DNS-rebinding windows.
        const result = await executeHttpProxy(
          {
            method: 'GET',
            url,
            headers: { Accept: 'application/json, application/yaml, text/yaml, text/plain' },
          },
          async (request) =>
            (await makePinnedFetcher(request.url, { allowLocalhost: false }))(request),
          { allowLocalhost: false, allowPrivateIPs: false }
        );
        if (!result.ok)
          return { ok: false as const, error: 'The import download failed security checks.' };
        if (result.response.bodyEncoding)
          return { ok: false as const, error: 'The import source must be text.' };
        const contentType = result.response.headers['content-type'];
        return {
          ok: true as const,
          text: result.response.body,
          ...(contentType ? { contentType } : {}),
        };
      } catch {
        return { ok: false as const, error: 'The import download failed security checks.' };
      }
    })
  );
}
