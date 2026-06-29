import * as yaml from 'js-yaml';
import { executeHttpProxy } from '../../../shared/protocol/http-proxy';
import type { NormalizedResponse } from '../../../shared/protocol/types';
import { nodeFetcher } from '../util/nodeFetcher';
import { findCollectionRoot, loadDefaultEnvVars } from '../workspace/collectionLocate';
import { mapHttpElementToSpec } from './ocRequestMapper';

export interface SendOptions {
  allowLocalhost: boolean;
  allowPrivateIPs: boolean;
}

export type SendOutcome =
  | { ok: true; response: NormalizedResponse; warnings: string[]; url: string }
  | { ok: false; error: string; warnings: string[] };

/**
 * Send a single OpenCollection HTTP request through the shared protocol core
 * (SSRF guard, header policy, body builder, redirect follower) using the Node
 * extension host as the fetcher backend. Variables are resolved from the
 * collection's default environment.
 */
export async function sendRequest(
  filePath: string,
  text: string,
  opts: SendOptions
): Promise<SendOutcome> {
  let doc: unknown;
  try {
    doc = yaml.load(text, { schema: yaml.JSON_SCHEMA });
  } catch (err) {
    return { ok: false, error: `Invalid YAML: ${(err as Error).message}`, warnings: [] };
  }

  const root = findCollectionRoot(filePath);
  const vars = root ? loadDefaultEnvVars(root) : {};

  let mapped;
  try {
    mapped = mapHttpElementToSpec(doc, vars);
  } catch (err) {
    return { ok: false, error: (err as Error).message, warnings: [] };
  }

  const result = await executeHttpProxy(mapped.spec, nodeFetcher, {
    allowLocalhost: opts.allowLocalhost,
    allowPrivateIPs: opts.allowPrivateIPs,
  });

  if (result.ok) {
    return { ok: true, response: result.response, warnings: mapped.warnings, url: mapped.spec.url };
  }
  return { ok: false, error: result.payload.error, warnings: mapped.warnings };
}
