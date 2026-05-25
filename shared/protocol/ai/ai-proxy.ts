import type { Fetcher, FetcherResponse } from '@shared/protocol/types';
import { SseParser } from '@shared/protocol/sse-parser';
import { detectUnredactedSecrets } from './redaction';
import type { ChatRequestSpec, ChatStreamEvent } from './types';
import { PROVIDER_ROUTES } from './provider-routes';
import { getProviderModule } from './providers';

type SecretResolver = (handleId: string) => Promise<string | undefined>;

/**
 * Orchestrates an AI chat call. Resolves the API-key handle, runs the
 * defense-in-depth paranoia pass, builds the provider-specific request,
 * fetches the upstream SSE stream, and yields normalised ChatStreamEvents.
 *
 * Backend-agnostic — the Electron handler supplies a Node-backed Fetcher and a
 * secretResolver reading from the encrypted handle store. Same orchestrator
 * runs regardless of backend.
 */
export async function* executeAiChat(
  spec: ChatRequestSpec,
  fetcher: Fetcher,
  secretResolver: SecretResolver,
): AsyncGenerator<ChatStreamEvent, void, unknown> {
  // 1. Paranoia pass on outgoing messages.
  if (!spec.rawMode) {
    const blob = spec.messages.map((m) => m.content).join('\n');
    if (detectUnredactedSecrets(blob)) {
      yield {
        type: 'error',
        code: 'guard',
        message:
          'Refused to send: messages still contain raw secrets after redaction. ' +
          'Toggle "Send raw" if this is intentional.',
      };
      yield { type: 'done' };
      return;
    }
  }

  // 2. Resolve API key handle.
  const apiKey = await secretResolver(spec.apiKeyHandleId);
  if (!apiKey) {
    yield { type: 'error', code: 'guard', message: 'API key not found for handle.' };
    yield { type: 'done' };
    return;
  }

  // 3. Build provider request.
  const route = PROVIDER_ROUTES[spec.provider];
  const { url, headers, body } = route.buildRequest(spec, apiKey);

  // 4. Fetch.
  let response: FetcherResponse;
  try {
    response = await fetcher({
      url,
      method: 'POST',
      headers,
      body,
      signal: spec.signal ?? new AbortController().signal,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const aborted = msg.toLowerCase().includes('abort');
    yield { type: 'error', code: aborted ? 'aborted' : 'network', message: aborted ? 'Stream aborted.' : msg };
    yield { type: 'done' };
    return;
  }

  const ok = response.status >= 200 && response.status < 300;
  if (!ok) {
    let detail = '';
    try {
      detail = await response.text();
    } catch {
      detail = '';
    }
    yield {
      type: 'error',
      code: 'provider',
      message: `Provider ${response.status}: ${detail.slice(0, 500)}`,
    };
    yield { type: 'done' };
    return;
  }

  if (!response.body) {
    yield { type: 'error', code: 'provider', message: 'No response body from provider.' };
    yield { type: 'done' };
    return;
  }

  // 5. Decode stream.
  const decoder = getProviderModule(spec.provider).createDecoder(spec.model);
  const parser = new SseParser();
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      for (const sse of parser.feed(value)) {
        for (const ev of decoder.feed(sse.data, sse.event)) yield ev;
      }
    }
    for (const sse of parser.flush()) {
      for (const ev of decoder.feed(sse.data, sse.event)) yield ev;
    }
    for (const ev of decoder.flush()) yield ev;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.toLowerCase().includes('abort')) {
      yield { type: 'error', code: 'aborted', message: 'Stream aborted.' };
    } else {
      yield { type: 'error', code: 'network', message: msg };
    }
    yield { type: 'done' };
  }
}
