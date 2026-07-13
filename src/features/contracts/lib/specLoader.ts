/**
 * Spec loader — turn a `ContractSpecSource` into a fully-parsed and
 * `$ref`-resolved OpenAPI document.
 *
 * Strategy:
 *  - URL sources: fetch via SSRF-guarded request through the existing
 *    proxy layer. `external: false` so the parser doesn't follow $refs to
 *    arbitrary URLs the user didn't authorise.
 *  - Inline sources (YAML or JSON): detect format from a heuristic + parse.
 *  - File sources (desktop only): main process reads the file via IPC and
 *    forwards the text content; this loader handles the parse step only.
 *
 * The parsed doc is returned as `OpenAPIV3.Document | OpenAPIV3_1.Document`.
 * Both shapes are very similar; the validator handles 3.0 (JSON Schema
 * Draft-7) and 3.1 (Draft 2020-12) differently.
 *
 * Caching is the responsibility of `useContractStore` — this module is
 * stateless.
 */

import SwaggerParser from '@apidevtools/swagger-parser';
import * as yaml from 'js-yaml';
import type { OpenAPIV3, OpenAPIV3_1 } from 'openapi-types';
import { isElectron } from '@/lib/shared/platform';
import { executeProxiedRequest } from '@/lib/shared/transport';
import type { ContractSpecSource } from '@/types';

export type { OpenAPIV3, OpenAPIV3_1 } from 'openapi-types';

export type ParsedSpec = OpenAPIV3.Document | OpenAPIV3_1.Document;

export interface SpecLoadResult {
  ok: true;
  spec: ParsedSpec;
  /** OpenAPI 3.0 ⟶ 'draft-07'; OpenAPI 3.1 ⟶ '2020-12'. */
  schemaDialect: 'draft-07' | '2020-12';
}
export interface SpecLoadError {
  ok: false;
  error: string;
  /** Where the error happened — load (fetch/IO) vs parse (YAML/JSON/$ref). */
  stage: 'load' | 'parse' | 'validate';
}

export type LoadResult = SpecLoadResult | SpecLoadError;

/**
 * Load + parse a spec from its source. URL sources use the shared proxy
 * transport, so the same SSRF and redirect policy applies as normal requests.
 */
export async function loadContractSpec(source: ContractSpecSource): Promise<LoadResult> {
  let raw: string;
  try {
    raw = await readRawSource(source);
  } catch (err) {
    return {
      ok: false,
      stage: 'load',
      error: err instanceof Error ? err.message : String(err),
    };
  }

  let parsed: unknown;
  try {
    parsed = raw.trimStart().startsWith('{') ? JSON.parse(raw) : yaml.load(raw);
  } catch (err) {
    return {
      ok: false,
      stage: 'parse',
      error: `Failed to parse spec: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  try {
    // dereference resolves $refs in-place but only follows internal refs
    // unless `resolve.external` is true. The SwaggerParser.dereference
    // overload expects a `Document` shape, so we cast through unknown.
    const deref = (await SwaggerParser.dereference(parsed as never, {
      resolve: { external: false },
    })) as unknown as ParsedSpec;

    const version = String(deref.openapi ?? '');
    const dialect: 'draft-07' | '2020-12' = version.startsWith('3.1') ? '2020-12' : 'draft-07';
    return { ok: true, spec: deref, schemaDialect: dialect };
  } catch (err) {
    return {
      ok: false,
      stage: 'parse',
      error: `Failed to dereference spec: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function readRawSource(source: ContractSpecSource): Promise<string> {
  switch (source.source) {
    case 'inline':
      if (!source.inline) throw new Error('inline spec has empty content');
      return source.inline;
    case 'url':
      if (!source.url) throw new Error('url spec has empty url field');
      return fetchSpecUrl(source.url);
    case 'file':
      if (!source.filePath) throw new Error('file spec has empty filePath');
      return fetchSpecFile(source.filePath);
    default:
      throw new Error(`Unknown spec source: ${(source as { source: string }).source}`);
  }
}

async function fetchSpecUrl(url: string): Promise<string> {
  const res = await executeProxiedRequest({
    method: 'GET',
    headers: { Accept: 'application/json, application/yaml, text/yaml, */*' },
    url,
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`HTTP ${res.status} fetching spec from ${url}`);
  }
  return typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
}

async function fetchSpecFile(filePath: string): Promise<string> {
  // Desktop-only path. File-text reading lives on a future IPC channel —
  // for now surface a clear "not yet supported" error so callers can fall back.
  void filePath;
  if (!isElectron()) {
    throw new Error('File-source specs are only supported in the desktop app');
  }
  throw new Error(
    'File-source specs are not yet implemented — paste the spec inline or use a URL source for now'
  );
}
