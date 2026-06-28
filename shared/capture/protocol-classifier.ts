/**
 * Classify a captured exchange into one of the supported protocols.
 *
 * Pure and dependency-free so both the extension and the desktop bridge share
 * one source of truth for "what kind of request is this".
 */
import type { CapturedGraphql, CapturedHeader, CapturedProtocol } from './types';

export interface ClassifyInput {
  url: string;
  requestHeaders: CapturedHeader[];
  requestBodyText?: string;
  isWebSocket?: boolean;
  isEventStream?: boolean;
}

export interface ClassifyResult {
  protocol: CapturedProtocol;
  graphql?: CapturedGraphql;
}

function headerValue(headers: CapturedHeader[], name: string): string | undefined {
  const lower = name.toLowerCase();
  return headers.find((header) => header.name.toLowerCase() === lower)?.value;
}

function parseGraphql(bodyText: string | undefined): CapturedGraphql | undefined {
  if (!bodyText) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return undefined;
  }
  const obj = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!obj || typeof obj !== 'object') return undefined;
  const query = (obj as Record<string, unknown>).query;
  if (typeof query !== 'string') return undefined;
  const operationName = (obj as Record<string, unknown>).operationName;
  const match = /\b(query|mutation|subscription)\b/.exec(query);
  return {
    ...(typeof operationName === 'string' ? { operationName } : {}),
    operationType: (match?.[1] as CapturedGraphql['operationType']) ?? 'query',
  };
}

export function classifyProtocol(input: ClassifyInput): ClassifyResult {
  if (input.isWebSocket) return { protocol: 'websocket' };
  if (input.isEventStream) return { protocol: 'sse' };

  const contentType = headerValue(input.requestHeaders, 'content-type') ?? '';
  if (contentType.toLowerCase().startsWith('application/grpc-web')) {
    return { protocol: 'grpc-web' };
  }

  const graphql = parseGraphql(input.requestBodyText);
  const looksLikeGraphqlUrl = /\/graphql\/?($|\?)/i.test(input.url);
  if (graphql && (looksLikeGraphqlUrl || contentType.toLowerCase().includes('json'))) {
    return { protocol: 'graphql', graphql };
  }
  if (looksLikeGraphqlUrl) {
    return { protocol: 'graphql', ...(graphql ? { graphql } : {}) };
  }

  return { protocol: 'rest' };
}
