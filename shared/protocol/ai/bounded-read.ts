import { MAX_RESPONSE_SIZE } from '@shared/protocol/proxy-limits';
import type { FetcherResponse } from '@shared/protocol/types';

/** Provider/discovery error bodies are only ever previewed (a few hundred chars). */
const ERROR_BODY_PREVIEW_BYTES = 8 * 1024;

export class ResponseTooLargeError extends Error {
  constructor() {
    super(`Response too large (max ${MAX_RESPONSE_SIZE / 1024 / 1024}MB)`);
    this.name = 'ResponseTooLargeError';
  }
}

/**
 * Read a success body as text with the shared response cap applied WHILE
 * streaming (the stream is cancelled at the cap, so memory stays bounded).
 * Throws {@link ResponseTooLargeError} when exceeded. Fetchers that expose no
 * stream fall back to `text()` plus a length check.
 */
export async function readBoundedText(
  response: FetcherResponse,
  maxBytes: number = MAX_RESPONSE_SIZE
): Promise<string> {
  if (response.contentLengthHeader && Number(response.contentLengthHeader) > maxBytes) {
    throw new ResponseTooLargeError();
  }
  if (!response.body) {
    const text = await response.text();
    if (text.length > maxBytes) throw new ResponseTooLargeError();
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ResponseTooLargeError();
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

/**
 * Read at most {@link ERROR_BODY_PREVIEW_BYTES} of an error body. Truncates
 * rather than fails so the real provider error is still shown, and cancels the
 * stream so a hostile endpoint can't keep feeding it.
 */
export async function readErrorPreview(response: FetcherResponse): Promise<string> {
  if (!response.body) return (await response.text()).slice(0, ERROR_BODY_PREVIEW_BYTES);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.length;
      text += decoder.decode(value, { stream: true });
      if (total >= ERROR_BODY_PREVIEW_BYTES) {
        await reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return text + decoder.decode();
}
