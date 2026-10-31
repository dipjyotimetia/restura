import type { ChatStreamEvent } from '@shared/protocol/ai/types';
import type { ModelInfo, ProviderModule, StreamDecoder } from './types';

/**
 * Amazon Bedrock Converse (`/model/{modelId}/converse`). ConverseStream uses
 * AWS's binary event-stream framing, not SSE, so the route asks for the
 * non-streaming Converse call (`responseMode: 'json'`) and this decoder is fed
 * the whole JSON body once.
 *
 * Bedrock prices per model, region and agreement; there is no static table,
 * so cost reads as unknown (pricingKnown=false).
 */
const MODELS: ModelInfo[] = [];

interface ConverseResponse {
  output?: {
    message?: {
      content?: Array<{
        text?: string;
        toolUse?: { toolUseId?: string; name?: string; input?: unknown };
      }>;
    };
  };
  stopReason?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheWriteInputTokens?: number;
  };
  message?: string;
}

class BedrockConverseDecoder implements StreamDecoder {
  private buffered: ChatStreamEvent[] = [];

  feed(body: string): ChatStreamEvent[] {
    let response: ConverseResponse;
    try {
      response = JSON.parse(body) as ConverseResponse;
    } catch {
      this.buffered.push({ type: 'error', code: 'parse', message: 'Malformed Converse response' });
      return this.drain();
    }
    if (!response?.output?.message) {
      this.buffered.push({
        type: 'error',
        code: 'provider',
        message: response?.message ?? 'Converse response has no output message',
      });
      return this.drain();
    }
    for (const block of response.output.message.content ?? []) {
      if (typeof block.text === 'string' && block.text.length > 0) {
        this.buffered.push({ type: 'delta', text: block.text });
      }
      if (block.toolUse?.name && block.toolUse.toolUseId) {
        this.buffered.push({
          type: 'tool_call',
          id: block.toolUse.toolUseId,
          name: block.toolUse.name,
          input: JSON.stringify(block.toolUse.input ?? {}),
        });
      }
    }
    const usage = response.usage;
    if (usage?.inputTokens != null && usage.outputTokens != null) {
      const cacheRead = usage.cacheReadInputTokens ?? 0;
      const cacheWrite = usage.cacheWriteInputTokens ?? 0;
      this.buffered.push({
        type: 'usage',
        usage: {
          // Converse reports cache tokens separately from inputTokens; the wire
          // Usage contract counts them inside promptTokens.
          promptTokens: usage.inputTokens + cacheRead + cacheWrite,
          completionTokens: usage.outputTokens,
          ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
          ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
          estimatedCostUSD: 0,
        },
      });
    }
    return this.drain();
  }

  flush(): ChatStreamEvent[] {
    this.buffered.push({ type: 'done' });
    return this.drain();
  }

  private drain(): ChatStreamEvent[] {
    const out = this.buffered;
    this.buffered = [];
    return out;
  }
}

export const bedrockModule: ProviderModule = {
  provider: 'bedrock',
  models: MODELS,
  createDecoder: () => new BedrockConverseDecoder(),
};

/** `bedrock-runtime.{region}.amazonaws.com` (and the FIPS variant) → region. */
export function bedrockRegionFromUrl(url: string): string | undefined {
  const host = new URL(url).hostname.toLowerCase();
  return /^bedrock-runtime(?:-fips)?\.([a-z0-9-]+)\.amazonaws\.com(?:\.cn)?$/.exec(host)?.[1];
}

/** IAM credentials stored as the provider secret (JSON); any other value is a Bedrock API key. */
export interface BedrockIamCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export function parseBedrockIamCredentials(secret: string): BedrockIamCredentials | undefined {
  if (!secret.trimStart().startsWith('{')) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(secret);
  } catch {
    throw new Error('Bedrock credentials JSON is malformed');
  }
  const { accessKeyId, secretAccessKey, sessionToken } = (parsed ?? {}) as Record<string, unknown>;
  if (typeof accessKeyId !== 'string' || typeof secretAccessKey !== 'string') {
    throw new Error('Bedrock credentials JSON needs accessKeyId and secretAccessKey');
  }
  return {
    accessKeyId,
    secretAccessKey,
    ...(typeof sessionToken === 'string' && sessionToken ? { sessionToken } : {}),
  };
}
