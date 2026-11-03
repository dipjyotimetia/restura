import { v4 as uuid } from 'uuid';
import type { MultipartPart, RequestBody } from '../types';

/**
 * multipart/mixed request bodies in an OpenCollection document. No OC body
 * variant carries one, so — like Restura's `raw.format` / `multipartForm`
 * shapes — it travels under Restura's own `multipartMixed` body key.
 */
export const MULTIPART_MIXED_BODY_KEY = 'multipartMixed';

export function multipartMixedToOC(parts: MultipartPart[] | undefined): unknown {
  return { [MULTIPART_MIXED_BODY_KEY]: { parts: parts ?? [] } };
}

/** Inverse of {@link multipartMixedToOC}; malformed parts are dropped, a missing id is minted. */
export function multipartMixedFromOC(value: unknown): RequestBody {
  const parts = (value as { parts?: unknown } | null)?.parts;
  return {
    type: 'multipart-mixed',
    multipartParts: (Array.isArray(parts) ? parts : []).flatMap(partFromOC),
  };
}

function partFromOC(part: unknown): MultipartPart[] {
  if (!part || typeof part !== 'object') return [];
  const p = part as Record<string, unknown>;
  if (typeof p.contentType !== 'string' || typeof p.content !== 'string') return [];
  const out: MultipartPart = {
    id: typeof p.id === 'string' && p.id ? p.id : uuid(),
    contentType: p.contentType,
    content: p.content,
  };
  if (p.headers && typeof p.headers === 'object' && !Array.isArray(p.headers)) {
    const headers = Object.entries(p.headers).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    );
    if (headers.length > 0) out.headers = Object.fromEntries(headers);
  }
  return [out];
}
