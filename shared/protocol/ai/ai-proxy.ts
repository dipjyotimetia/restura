import { MAX_RESPONSE_SIZE } from '@shared/protocol/proxy-limits';
import { SseParser } from '@shared/protocol/sse-parser';
import type { Fetcher, FetcherResponse } from '@shared/protocol/types';
import { ResponseTooLargeError, readBoundedText, readErrorPreview } from './bounded-read';
import { PROVIDER_ROUTES, type ProviderRouteContext } from './provider-routes';
import { getProviderModule } from './providers';
import { detectUnredactedSecrets, scrubProviderError, scrubSecretText } from './redaction';
import type { ChatRequestSpec, ChatStreamEvent } from './types';

type SecretResolver = (handleId: string) => Promise<string | undefined>;

/**
 * Classify a thrown error as a user/abort cancellation. Prefer the signal's
 * own `aborted` flag and the standard `AbortError` name over substring-matching
 * the message — a provider error whose text merely contains "abort" must not be
 * misreported as a cancellation (which would hide the real failure).
 */
function isAbortError(e: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;
  return e instanceof Error && e.name === 'AbortError';
}

/**
 * Orchestrates an AI chat call. Resolves the API-key handle, runs the
 * defense-in-depth paranoia pass, builds the provider-specific request,
 * fetches the upstream SSE stream, and yields normalised ChatStreamEvents.
 *
 * Backend-agnostic — the Electron handler supplies a Node-backed Fetcher and a
 * secretResolver reading from the encrypted handle store. Same orchestrator
 * runs regardless of backend.
 */
/** Provider-supplied error text can echo the auth header, even inside a 200 stream. */
function scrubEvent(ev: ChatStreamEvent, apiKey: string): ChatStreamEvent {
  return ev.type === 'error' ? { ...ev, message: scrubSecretText(ev.message, apiKey) } : ev;
}

export async function* executeAiChat(
  spec: ChatRequestSpec,
  fetcher: Fetcher,
  secretResolver: SecretResolver,
  routeContext: ProviderRouteContext = {}
): AsyncGenerator<ChatStreamEvent, void, unknown> {
  // 1. Paranoia pass on outgoing messages.
  if (!spec.rawMode) {
    // Replayed assistant tool calls carry arguments the model (or a tool result
    // it echoed) produced, so scan those too, not just `content`.
    const blob = spec.messages
      .flatMap((m) => [m.content, ...(m.toolCalls ?? []).map((call) => call.input)])
      .join('\n');
    if (detectUnredactedSecrets(blob)) {
      yield {
        type: 'error',
        code: 'guard',
        message:
          'Refused to send: messages still contain raw secrets after redaction. ' +
          'If sending them is intentional, enable the unredacted-send override: ' +
          '"Send raw" in the assistant, or "Send unredacted to cloud providers" in AI Lab.',
      };
      yield { type: 'done' };
      return;
    }
  }

  // 2. Resolve API key handle. Local runtimes (a bare Ollama) need no key, so an
  // empty handle id is allowed and yields an empty key (the route then omits the
  // Authorization header). A non-empty handle that fails to resolve is still an
  // error — that's a misconfiguration, not an intentionally keyless endpoint.
  let apiKey = '';
  if (spec.apiKeyHandleId) {
    const resolved = await secretResolver(spec.apiKeyHandleId);
    if (resolved == null) {
      yield { type: 'error', code: 'guard', message: 'API key not found for handle.' };
      yield { type: 'done' };
      return;
    }
    apiKey = resolved;
  }

  // 3. Build (and, for SigV4 providers, sign) the provider request.
  const route = PROVIDER_ROUTES[spec.provider];
  let built: ReturnType<typeof route.buildRequest>;
  try {
    built = route.buildRequest(spec, apiKey);
    if (route.sign) built = await route.sign(built, apiKey, routeContext);
  } catch (e) {
    yield {
      type: 'error',
      code: 'guard',
      message: scrubSecretText(e instanceof Error ? e.message : String(e), apiKey),
    };
    yield { type: 'done' };
    return;
  }
  const { url, headers, body } = built;

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
    if (isAbortError(e, spec.signal)) {
      yield { type: 'error', code: 'aborted', message: 'Stream aborted.' };
    } else {
      yield {
        type: 'error',
        code: 'network',
        message: scrubSecretText(e instanceof Error ? e.message : String(e), apiKey),
      };
    }
    yield { type: 'done' };
    return;
  }

  const ok = response.status >= 200 && response.status < 300;
  if (!ok) {
    let detail = '';
    try {
      detail = await readErrorPreview(response);
    } catch {
      detail = '';
    }
    yield {
      type: 'error',
      code: 'provider',
      message: `Provider ${response.status}: ${scrubProviderError(detail, apiKey, 500)}`,
    };
    yield { type: 'done' };
    return;
  }

  const decoder = getProviderModule(spec.provider).createDecoder(spec.model);
  if (route.responseMode === 'json') {
    // One JSON document (Bedrock Converse), capped while it streams in.
    try {
      const text = await readBoundedText(response);
      for (const ev of decoder.feed(text)) yield scrubEvent(ev, apiKey);
      for (const ev of decoder.flush()) yield scrubEvent(ev, apiKey);
    } catch (e) {
      yield {
        type: 'error',
        code: isAbortError(e, spec.signal) ? 'aborted' : 'network',
        message: isAbortError(e, spec.signal)
          ? 'Stream aborted.'
          : scrubSecretText(e instanceof Error ? e.message : String(e), apiKey),
      };
      yield { type: 'done' };
    }
    return;
  }

  if (!response.body) {
    yield { type: 'error', code: 'provider', message: 'No response body from provider.' };
    yield { type: 'done' };
    return;
  }

  // 5. Decode stream.
  const parser = new SseParser();
  const reader = response.body.getReader();
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.length;
      if (received > MAX_RESPONSE_SIZE) {
        await reader.cancel();
        throw new ResponseTooLargeError();
      }
      for (const sse of parser.feed(value)) {
        for (const ev of decoder.feed(sse.data, sse.event)) yield scrubEvent(ev, apiKey);
      }
    }
    for (const sse of parser.flush()) {
      for (const ev of decoder.feed(sse.data, sse.event)) yield scrubEvent(ev, apiKey);
    }
    for (const ev of decoder.flush()) yield scrubEvent(ev, apiKey);
  } catch (e) {
    if (isAbortError(e, spec.signal)) {
      yield { type: 'error', code: 'aborted', message: 'Stream aborted.' };
    } else {
      yield {
        type: 'error',
        code: 'network',
        message: scrubSecretText(e instanceof Error ? e.message : String(e), apiKey),
      };
    }
    yield { type: 'done' };
  }
}
