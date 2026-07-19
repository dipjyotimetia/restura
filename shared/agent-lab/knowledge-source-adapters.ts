import type { KnowledgeSource, KnowledgeSourceDescriptor } from './knowledge-source';

// ── RetrievalAdapter ──────────────────────────────────────────────────────

/** Result of a retrieval query. */
export interface RetrievalResult {
  sourceId: string;
  content: string;
  score: number;
  metadata?: Record<string, unknown>;
}

/**
 * Optional retrieval/index adapter.
 *
 * The baseline is deterministic bounded extraction (no adapter needed).
 * Vector indexing is an opt-in local implementation, not a mandatory vendor
 * dependency. Implementations must be local by default; any remote embedding
 * provider requires a separate explicit opt-in.
 */
export interface RetrievalAdapter {
  readonly name: string;
  readonly local: boolean;

  /** Index a knowledge source's content for retrieval. */
  index(source: KnowledgeSource, signal?: AbortSignal): Promise<void>;

  /** Query the index for relevant content. */
  query(
    query: string,
    options: { topK: number; signal?: AbortSignal }
  ): Promise<RetrievalResult[]>;

  /** Remove a source from the index. */
  remove(sourceId: string, signal?: AbortSignal): Promise<void>;

  /** Clear the entire index. */
  clear(signal?: AbortSignal): Promise<void>;
}

// ── External source adapter contract ──────────────────────────────────────

/**
 * OAuth/SecretRef configuration for external source adapters.
 */
export interface OAuthConfig {
  provider: string;
  clientId: string;
  scopes: string[];
  /** Optional: an environment variable or secret handle for the token. */
  tokenRef?: string;
}

export interface SecretRef {
  source: 'env' | 'secret-handle';
  name?: string;
  id?: string;
}

/**
 * Configuration for an external source adapter.
 */
export interface ExternalSourceConfig {
  /** URL or endpoint for the external source. */
  url: string;
  /** OAuth configuration (if applicable). */
  oauth?: OAuthConfig;
  /** Secret reference (if applicable). */
  secretRef?: SecretRef;
  /** Timeout in milliseconds for external operations. */
  timeoutMs?: number;
  /** Whether to allow localhost URLs (requires explicit opt-in). */
  allowLocalhost?: boolean;
}

/**
 * Redaction function for external source content.
 * Implementations must redact sensitive fields based on the source type.
 */
export type RedactionFn = (content: string) => string;

/**
 * Adapter contract for external sources (GitHub, Jira, Confluence, web, etc.).
 *
 * Implementations must:
 * - Not silently crawl the network
 * - Use existing URL validation and platform controls for URL-bearing sources
 * - Apply source-specific redaction to remove secrets and sensitive data
 * - Support cancellation via AbortSignal
 */
export interface ExternalSourceAdapter {
  /** Unique identifier for this adapter type (e.g., 'github', 'jira', 'confluence'). */
  readonly kind: string;
  /** Human-readable label. */
  readonly label: string;
  /** Whether this adapter is available on the current platform. */
  readonly available: boolean;

  /** Validate the source configuration before fetching. */
  validate(config: ExternalSourceConfig): string[];

  /** Fetch content from the external source and return a knowledge source descriptor. */
  fetch(
    config: ExternalSourceConfig,
    signal?: AbortSignal
  ): Promise<KnowledgeSourceDescriptor>;

  /** Apply source-specific redaction to content. */
  redact: RedactionFn;
}

// ── Built-in redaction helpers ────────────────────────────────────────────

/** Redact URLs by removing credentials and query parameters. */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, 'REDACTED');
    return url.toString();
  } catch {
    return '[REDACTED URL]';
  }
}

/** Default no-op redaction (pass-through). */
export const noopRedaction: RedactionFn = (content: string) => content;

// ── RetrievalAdapterRegistry ──────────────────────────────────────────────

/**
 * Registry of available retrieval adapters.
 * No adapter is registered by default; all are opt-in.
 */
export class RetrievalAdapterRegistry {
  private readonly adapters = new Map<string, RetrievalAdapter>();

  register(adapter: RetrievalAdapter): void {
    if (this.adapters.has(adapter.name)) {
      throw new Error(`retrieval adapter already registered: ${adapter.name}`);
    }
    this.adapters.set(adapter.name, adapter);
  }

  get(name: string): RetrievalAdapter | undefined {
    return this.adapters.get(name);
  }

  list(): RetrievalAdapter[] {
    return [...this.adapters.values()];
  }

  /** List only local (non-remote) adapters. */
  listLocal(): RetrievalAdapter[] {
    return this.list().filter((a) => a.local);
  }

  unregister(name: string): void {
    this.adapters.delete(name);
  }

  clear(): void {
    this.adapters.clear();
  }
}

// ── ExternalSourceAdapterRegistry ─────────────────────────────────────────

export class ExternalSourceAdapterRegistry {
  private readonly adapters = new Map<string, ExternalSourceAdapter>();

  register(adapter: ExternalSourceAdapter): void {
    if (this.adapters.has(adapter.kind)) {
      throw new Error(`external source adapter already registered: ${adapter.kind}`);
    }
    this.adapters.set(adapter.kind, adapter);
  }

  get(kind: string): ExternalSourceAdapter | undefined {
    return this.adapters.get(kind);
  }

  list(): ExternalSourceAdapter[] {
    return [...this.adapters.values()];
  }

  listAvailable(): ExternalSourceAdapter[] {
    return this.list().filter((a) => a.available);
  }

  unregister(kind: string): void {
    this.adapters.delete(kind);
  }

  clear(): void {
    this.adapters.clear();
  }
}