import { loadCollection } from './collectionLoader.js';
import { undiciFetcher } from './undiciFetcher.js';
import { executeHttpProxy } from '@shared/protocol/http-proxy';
import type { Reporter, RunResult, RequestRunResult, RunMeta } from '../reporters/types.js';
import type { HttpRequest } from '@/types';

export interface RunOptions {
  envVars: Record<string, string>;
  bail: boolean;
  timeoutMs: number;
  allowLocalhost: boolean;
}

/**
 * Execute every request in a Restura file-collection.
 *
 * v0.1: HTTP requests only. gRPC/SSE/MCP request types are recorded as
 * "unsupported" results and counted as errored. Pre/post test scripts are
 * deferred — pass/fail is determined by HTTP status (2xx = pass).
 *
 * Variable resolution: `{{KEY}}` placeholders are resolved against the merged
 * env vars (env file first, collection variables override). Unresolved keys
 * are left as `{{KEY}}` so the upstream sees them and the user notices.
 */
export async function runCollection(
  collectionDir: string,
  options: RunOptions,
  reporter: Reporter
): Promise<RunResult> {
  const loaded = await loadCollection(collectionDir);

  // Merge: env vars first, then collection vars override.
  const allVars: Record<string, string> = { ...options.envVars };
  for (const v of loaded.meta.variables ?? []) {
    if ((v as { enabled?: boolean }).enabled !== false) allVars[v.key] = v.value;
  }

  const meta: RunMeta = {
    collectionName: loaded.meta.name,
    collectionDir,
    startedAt: Date.now(),
  };
  await reporter.onStart?.(meta);

  const results: RequestRunResult[] = [];
  let bailed = false;

  for (const item of loaded.requests) {
    if (bailed) break;
    await reporter.onRequestStart?.(item);

    if (item.type !== 'http') {
      const result: RequestRunResult = {
        request: item,
        status: 0,
        passed: false,
        durationMs: 0,
        bodyBytes: 0,
        errorMessage: `Request type '${item.type}' not yet supported by CLI v0.1`,
      };
      results.push(result);
      await reporter.onRequestComplete?.(result);
      if (options.bail) bailed = true;
      continue;
    }

    const httpReq = item.request as HttpRequest;
    const url = resolveVars(httpReq.url, allVars);
    const headersRecord: Record<string, string> = {};
    for (const h of httpReq.headers) {
      if (h.enabled && h.key) headersRecord[h.key] = resolveVars(h.value, allVars);
    }
    const paramsRecord: Record<string, string> = {};
    for (const p of httpReq.params) {
      if (p.enabled && p.key) paramsRecord[p.key] = resolveVars(p.value, allVars);
    }

    const hasBody =
      httpReq.body.type !== 'none' &&
      (httpReq.body as { raw?: string }).raw !== undefined;
    const bodyData = hasBody
      ? resolveVars((httpReq.body as { raw: string }).raw, allVars)
      : undefined;

    const start = Date.now();
    let runResult: RequestRunResult;
    try {
      const result = await executeHttpProxy(
        {
          method: httpReq.method,
          url,
          headers: headersRecord,
          params: paramsRecord,
          bodyType: hasBody ? 'raw' : 'none',
          ...(bodyData !== undefined ? { data: bodyData } : {}),
          timeout: options.timeoutMs,
        },
        undiciFetcher,
        { allowLocalhost: options.allowLocalhost }
      );
      const durationMs = Date.now() - start;

      if (result.ok) {
        runResult = {
          request: item,
          status: result.response.status,
          passed: result.response.status >= 200 && result.response.status < 300,
          durationMs,
          bodyBytes: result.response.size,
          responseHeaders: result.response.headers,
        };
      } else {
        runResult = {
          request: item,
          status: 0,
          passed: false,
          durationMs,
          bodyBytes: 0,
          errorMessage: result.payload.error,
        };
      }
    } catch (err) {
      runResult = {
        request: item,
        status: 0,
        passed: false,
        durationMs: Date.now() - start,
        bodyBytes: 0,
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }

    results.push(runResult);
    await reporter.onRequestComplete?.(runResult);
    if (!runResult.passed && options.bail) bailed = true;
  }

  const summary = {
    total: results.length,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed && !r.errorMessage).length,
    errored: results.filter((r) => r.errorMessage !== undefined).length,
  };

  const final: RunResult = {
    meta,
    durationMs: Date.now() - meta.startedAt,
    requests: results,
    summary,
  };
  await reporter.onEnd(final);
  return final;
}

function resolveVars(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_match, key: string) => {
    return vars[key] ?? `{{${key}}}`;
  });
}
