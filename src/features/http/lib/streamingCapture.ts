/**
 * The streamed HTTP body, captured as text while the viewer renders it, so a
 * streaming send can hand its test script and history entry a response the
 * way a buffered send does.
 */
import { textDecoderFor } from '@shared/protocol/binary';
import { MAX_RESPONSE_SIZE } from '@shared/protocol/proxy-limits';
import { v4 as uuidv4 } from 'uuid';
import { formatBytes } from '@/lib/shared/utils';
import type { Response as ApiResponse } from '@/types';
import { detectStreamFormat, type HttpStreamEvent } from './streamingResponseReader';

export interface StreamCapture {
  /** Feed every body chunk (`readStreamingResponse`'s `onBytes`). */
  onBytes: (chunk: Uint8Array) => void;
  /** The captured text so far, and whether the cap cut it short. */
  read: () => { text: string; bytesReceived: number; bytesKept: number; truncated: boolean };
}

/**
 * Keep the first `maxBytes` of the body (the proxy's buffered-response cap by
 * default), decoded as the reader decodes it: SSE / NDJSON as UTF-8, other
 * streams in the declared charset.
 */
export function createStreamCapture(
  contentType: string | undefined,
  maxBytes: number = MAX_RESPONSE_SIZE
): StreamCapture {
  const decoder =
    detectStreamFormat(contentType) === 'raw' ? textDecoderFor(contentType) : new TextDecoder();
  let text = '';
  let kept = 0;
  let bytesReceived = 0;
  let flushed = false;
  return {
    onBytes(chunk) {
      bytesReceived += chunk.byteLength;
      if (kept >= maxBytes) return;
      const slice = kept + chunk.byteLength > maxBytes ? chunk.subarray(0, maxBytes - kept) : chunk;
      kept += slice.byteLength;
      text += decoder.decode(slice, { stream: true });
    },
    read() {
      if (!flushed) {
        flushed = true;
        text += decoder.decode();
      }
      return { text, bytesReceived, bytesKept: kept, truncated: bytesReceived > kept };
    },
  };
}

export interface StreamResponseMeta {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  setCookies?: string[];
}

/**
 * The response a finished stream amounts to: status and headers from the
 * first bytes, the captured text as the body, time to the terminal event.
 */
export function streamedResponse(input: {
  requestId: string;
  meta: StreamResponseMeta;
  capture: StreamCapture;
  startTime: number;
  terminal: HttpStreamEvent | undefined;
}): ApiResponse {
  const { text, bytesReceived, bytesKept, truncated } = input.capture.read();
  const notices: string[] = [];
  if (input.terminal?.type === 'error')
    notices.push(`Stream ended with an error: ${input.terminal.error}`);
  if (truncated) {
    notices.push(
      `Streamed body truncated: showing the first ${formatBytes(bytesKept)} of ${formatBytes(bytesReceived)} received.`
    );
  }
  return {
    id: uuidv4(),
    requestId: input.requestId,
    status: input.meta.status,
    statusText: input.meta.statusText,
    headers: input.meta.headers,
    ...(input.meta.setCookies !== undefined ? { setCookies: input.meta.setCookies } : {}),
    body: text,
    size: bytesReceived,
    time: Date.now() - input.startTime,
    timestamp: Date.now(),
    ...(notices.length > 0 ? { bodyNotice: notices.join(' ') } : {}),
  };
}
