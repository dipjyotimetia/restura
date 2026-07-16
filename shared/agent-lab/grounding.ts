export type GroundingSourceKind =
  | 'collection'
  | 'openapi'
  | 'graphql'
  | 'proto'
  | 'history'
  | 'mcp-catalog';

/** Sanitized source material supplied by a platform-specific resolver. */
export interface GroundingSource {
  id: string;
  kind: GroundingSourceKind;
  label: string;
  version: string;
  content: string;
}

/** Bounded evidence injected into a model request and retained in a run trace. */
export interface ContextPacket {
  sourceId: string;
  kind: GroundingSourceKind;
  label: string;
  version: string;
  content: string;
  truncated: boolean;
}

export interface GroundingSelection {
  sourceIds: string[];
  maxBytes: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function truncateUtf8(value: string, maxBytes: number): { content: string; truncated: boolean } {
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= maxBytes) return { content: value, truncated: false };
  return { content: decoder.decode(bytes.slice(0, maxBytes)), truncated: true };
}

/**
 * Select only caller-authorized evidence. Source discovery belongs to platform
 * adapters; this pure layer never falls back to broader workspace search.
 */
export function buildContextPackets(
  sources: GroundingSource[],
  selection: GroundingSelection
): ContextPacket[] {
  if (!Number.isInteger(selection.maxBytes) || selection.maxBytes < 1) {
    throw new Error('grounding maxBytes must be a positive integer');
  }
  const byId = new Map(sources.map((source) => [source.id, source]));
  let remaining = selection.maxBytes;
  return selection.sourceIds.map((sourceId) => {
    const source = byId.get(sourceId);
    if (!source) throw new Error(`unknown grounding source: ${sourceId}`);
    const truncated = truncateUtf8(source.content, remaining);
    remaining -= encoder.encode(truncated.content).byteLength;
    return {
      sourceId: source.id,
      kind: source.kind,
      label: source.label,
      version: source.version,
      ...truncated,
    };
  });
}
