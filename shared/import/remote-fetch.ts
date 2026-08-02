import { validateURL } from '@shared/protocol/url-validation';

export const REMOTE_IMPORT_MAX_BYTES = 10 * 1024 * 1024;
export const REMOTE_IMPORT_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;

export interface RemoteImportResult {
  text: string;
  contentType: string;
  finalUrl: string;
}

export interface RemoteImportOptions {
  fetcher?: typeof fetch;
  /** Platform DNS rebind guard. Worker runtimes do not expose one. */
  guard?: (hostname: string) => Promise<void>;
  signal?: AbortSignal;
}

/**
 * Download an import artifact without inheriting request-execution privileges.
 * The only allowed input is a public, credential-free HTTPS URL; redirects are
 * followed manually so every target receives the same validation and DNS guard.
 */
export async function fetchRemoteImport(
  input: string,
  { fetcher = fetch, guard, signal }: RemoteImportOptions = {}
): Promise<RemoteImportResult> {
  let url = validateRemoteImportUrl(input);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REMOTE_IMPORT_TIMEOUT_MS);
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  try {
    for (let redirects = 0; ; redirects++) {
      await guard?.(url.hostname);
      const response = await fetcher(url.toString(), {
        method: 'GET',
        redirect: 'manual',
        headers: {
          Accept: 'application/json, application/yaml, text/yaml, text/plain;q=0.8, */*;q=0.1',
        },
        signal: controller.signal,
      });
      if (isRedirect(response.status)) {
        if (redirects >= MAX_REDIRECTS)
          throw new Error(`Remote import has too many redirects (>${MAX_REDIRECTS}).`);
        const location = response.headers.get('location');
        if (!location) throw new Error('Remote import redirect did not include a Location header.');
        url = validateRemoteImportUrl(new URL(location, url).toString());
        continue;
      }
      if (!response.ok) throw new Error(`Remote import failed with HTTP ${response.status}.`);
      const declaredSize = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredSize) && declaredSize > REMOTE_IMPORT_MAX_BYTES) {
        throw new Error(
          `Remote import response is too large (max ${REMOTE_IMPORT_MAX_BYTES / 1024 / 1024}MB).`
        );
      }
      const bytes = await readBounded(response, REMOTE_IMPORT_MAX_BYTES);
      if (bytes.includes(0))
        throw new Error('Remote import must be a text artifact, not binary data.');
      return {
        text: new TextDecoder().decode(bytes),
        contentType:
          response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? '',
        finalUrl: url.toString(),
      };
    }
  } catch (error) {
    if (
      controller.signal.aborted &&
      !(error instanceof Error && error.message.includes('Remote import'))
    ) {
      throw new Error(
        signal?.aborted ? 'Remote import was cancelled.' : 'Remote import timed out.'
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

function validateRemoteImportUrl(input: string): URL {
  const validation = validateURL(input, {
    allowedSchemes: ['https:'],
    allowLocalhost: false,
    allowPrivateIPs: false,
  });
  if (!validation.valid) throw new Error(validation.error ?? 'Invalid remote import URL.');
  const url = new URL(input);
  if (url.username || url.password)
    throw new Error('Remote import URLs must not contain credentials.');
  return url;
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error(`Remote import response is too large (max ${maxBytes / 1024 / 1024}MB).`);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
