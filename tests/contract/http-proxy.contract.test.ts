/**
 * Cross-backend contract test for `executeHttpProxy`. Runs the same
 * `RequestSpec` table through both fetchers (`globalThis.fetch` and undici)
 * against a local Node HTTP upstream, then asserts the normalized
 * `ExecuteResult` matches across both rails.
 *
 * If a parity break ever lands (redirect handling, chunked decoding, header
 * case, body framing, etc.), this test surfaces it before users do.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executeHttpProxy } from '../../shared/protocol/http-proxy';
import type { ExecuteResult, RequestSpec } from '../../shared/protocol/types';
import { FETCHER_TABLE } from './fetchers';
import { startUpstream, type Upstream } from './upstream';

let upstream: Upstream;

beforeAll(async () => {
  upstream = await startUpstream();
});

afterAll(async () => {
  if (upstream) await upstream.stop();
});

function url(path: string): string {
  return `${upstream.baseUrl}${path}`;
}

interface Fixture {
  name: string;
  spec: () => RequestSpec;
  /** Optional projection to drop volatile fields (timing, server-set headers). */
  project?: (r: ExecuteResult) => unknown;
}

function defaultProject(r: ExecuteResult): unknown {
  if (!r.ok) return { ok: false, status: r.status, error: r.payload.error };
  // `statusText` is intentionally dropped: undici's `request` API doesn't expose
  // statusText (electron/main/handlers/http-handler.ts returns '' for the same
  // reason). Native fetch supplies "OK" / "Not Found" / etc. This is a known
  // backend asymmetry; if a future change derives statusText from the status
  // code in the electron fetcher, re-add it here to lock parity in.
  const { status, body, size } = r.response;
  return { ok: true, status, body, size };
}

/**
 * Status-only projection. Use for fixtures where the body legitimately differs
 * between fetchers due to default-header injection (fetch sends Accept,
 * User-Agent, sec-fetch-*; undici sends only Host/Connection). The contract
 * we want to verify there is "did the redirect resolve / did the body decode /
 * did the status come back", not "do both fetchers send identical headers".
 */
function statusAndOkOnly(r: ExecuteResult): unknown {
  if (!r.ok) return { ok: false, status: r.status, error: r.payload.error };
  return { ok: true, status: r.response.status };
}

const FIXTURES: Fixture[] = [
  {
    name: 'GET /echo/headers 200',
    spec: () => ({ method: 'GET', url: url('/echo/headers') }),
    // Body differs across fetchers (fetch injects more default headers than undici)
    // and that's about the fetcher, not executeHttpProxy. Only assert status reaches OK.
    project: statusAndOkOnly,
  },
  {
    name: 'GET ?query echoed',
    spec: () => ({ method: 'GET', url: url('/echo/headers'), params: { a: '1', b: 'two' } }),
    project: statusAndOkOnly,
  },
  {
    name: 'POST /echo/json roundtrip',
    spec: () => ({
      method: 'POST',
      url: url('/echo/json'),
      bodyType: 'json',
      data: '{"hello":"world"}',
    }),
  },
  {
    name: 'GET 404 path',
    spec: () => ({ method: 'GET', url: url('/echo/nonexistent') }),
  },
  {
    name: 'GET 500 explicit',
    spec: () => ({ method: 'GET', url: url('/echo/status/500') }),
  },
  {
    name: 'GET chunked body',
    spec: () => ({ method: 'GET', url: url('/echo/chunked') }),
  },
  {
    name: 'GET redirect chain (followed)',
    spec: () => ({ method: 'GET', url: url('/echo/redirect/3') }),
  },
  {
    name: 'GET 301 permanent redirect (followed)',
    spec: () => ({ method: 'GET', url: url('/echo/redirect-perm') }),
    // Final hop is /echo/headers — body diverges due to default-header injection.
    project: statusAndOkOnly,
  },
];

describe('contract: executeHttpProxy parity', () => {
  for (const fixture of FIXTURES) {
    it(`parity: ${fixture.name}`, async () => {
      const project = fixture.project ?? defaultProject;
      const results: Array<{ name: string; projected: unknown }> = [];
      for (const { name, fetcher } of FETCHER_TABLE) {
        const result = await executeHttpProxy(fixture.spec(), fetcher, { allowLocalhost: true });
        results.push({ name, projected: project(result) });
      }
      // Pairwise equality — all fetchers must agree.
      const [first, ...rest] = results;
      for (const other of rest) {
        expect(other.projected, `${other.name} vs ${first?.name}`).toEqual(first?.projected);
      }
    });
  }
});
