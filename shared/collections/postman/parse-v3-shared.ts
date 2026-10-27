import type { KeyValue, ScopedVariable } from '../../types';
import {
  type AuthOutcome,
  arr,
  convertAuthBlock,
  isObj,
  keyValue,
  type ParseContext,
  type Raw,
  str,
} from './common';
import { redactPostmanV3Raw } from './redaction';
import type { PostmanSidecar } from './sidecar';

/**
 * Helpers shared by the Postman v3 front end (`parse-v3.ts`) and its
 * protocol converters (`parse-v3-protocols.ts`): auth, scripts, variables,
 * the sidecar scrub, examples / schema and unmapped-settings carriage.
 */

// ── auth ────────────────────────────────────────────────────────────────────

/** v3 `{ type, credentials: [{ key, value }] }` → v2 `{ type, [type]: [...] }`. */
export function toV2AuthShape(set: Raw): Raw {
  const type = str(set.type);
  const credentials = arr(set.credentials)
    .filter(isObj)
    .map((c) => ({ key: str(c.key), value: c.value }));
  return { type, [type]: credentials };
}

export function convertAuth(
  raw: unknown,
  ownerName: string,
  sidecar: PostmanSidecar,
  ctx: ParseContext
): AuthOutcome {
  if (Array.isArray(raw)) {
    const sets = raw.filter(isObj);
    const [first] = sets;
    if (!first) return { auth: undefined };
    const out = convertAuthBlock(toV2AuthShape(first), ownerName, ctx);
    if (out.sidecarAuth) sidecar.auth = out.sidecarAuth;
    if (out.noauth) sidecar.noauth = true;
    if (sets.length > 1 || first.rules !== undefined) {
      ctx.report.unmodelled('multi-auth', ownerName);
      // Credential VALUES of the other sets are not kept (they would be
      // plaintext outside the typed model); only their shape, for reference.
      sidecar.authSets = sets.map((s) => ({
        ...(typeof s.id === 'string' ? { id: s.id } : {}),
        ...(typeof s.name === 'string' ? { name: s.name } : {}),
        type: str(s.type),
        ...(Array.isArray(s.rules) ? { rules: scrub(s.rules) } : {}),
        credentialKeys: arr(s.credentials)
          .filter(isObj)
          .map((c) => str(c.key)),
      }));
    }
    return out;
  }
  if (!isObj(raw)) return { auth: undefined };
  const out = convertAuthBlock(toV2AuthShape(raw), ownerName, ctx);
  if (out.sidecarAuth) sidecar.auth = out.sidecarAuth;
  // Explicit `noauth` (#1232): cuts inheritance and arms the send guard.
  if (out.noauth) sidecar.noauth = true;
  return out;
}

/**
 * Auth that is NOT mapped onto any typed model (broker presets carry no
 * credentials; placeholder items have no request): the whole block is
 * bag-only, so it is flagged for the redactor's count (`authBagOnly`).
 */
export function keepBagOnlyAuth(raw: Raw, sidecar: PostmanSidecar): void {
  if (!isObj(raw.auth)) return;
  sidecar.auth = toV2AuthShape(raw.auth);
  sidecar.authBagOnly = true;
}

// ── scripts ─────────────────────────────────────────────────────────────────

export const PRE_PHASES = new Set([
  'beforeRequest',
  'beforeQuery',
  'beforeInvoke',
  'http:beforeRequest',
]);
export const TEST_PHASES = new Set(['afterResponse', 'http:afterResponse']);

export interface Scripts {
  preRequestScript: string | undefined;
  testScript: string | undefined;
}

export function extractScripts(
  scripts: unknown,
  ownerName: string,
  sidecar: PostmanSidecar,
  ctx: ParseContext
): Scripts {
  let pre: string | undefined;
  let test: string | undefined;
  const shadowed: unknown[] = [];
  const unmapped: unknown[] = [];
  let usesPackages = false;
  for (const s of arr(scripts)) {
    if (!isObj(s) || typeof s.code !== 'string') continue;
    const type = str(s.type);
    const hasRefs =
      (isObj(s.packages) && Object.keys(s.packages).length > 0) ||
      (isObj(s.requests) && Object.keys(s.requests).length > 0);
    if (hasRefs) usesPackages = true;
    if (PRE_PHASES.has(type)) {
      if (pre !== undefined) shadowed.push(s);
      pre = ctx.transformScript(s.code);
    } else if (TEST_PHASES.has(type)) {
      if (test !== undefined) shadowed.push(s);
      test = ctx.transformScript(s.code);
    } else {
      unmapped.push(s);
    }
  }
  if (usesPackages) ctx.report.unmodelled('script-packages', ownerName);
  if (shadowed.length > 0) {
    sidecar.event = scrub(shadowed) as unknown[];
    ctx.report.unmodelled('extra-events', ownerName);
  }
  if (unmapped.length > 0) keepScripts(unmapped, ownerName, sidecar, ctx);
  return { preRequestScript: pre, testScript: test };
}

export function keepScripts(
  scripts: unknown[],
  ownerName: string,
  sidecar: PostmanSidecar,
  ctx: ParseContext
): void {
  sidecar.scripts = scrub(scripts) as unknown[];
  ctx.report.unmodelled('protocol-scripts', ownerName);
}

// ── rows / variables ────────────────────────────────────────────────────────

export function rows(v: unknown): KeyValue[] {
  return arr(v).filter(isObj).map(keyValue);
}

export function convertVariables(
  variables: unknown,
  ownerName: string,
  sidecar: PostmanSidecar,
  ctx: ParseContext
): ScopedVariable[] {
  const out: ScopedVariable[] = [];
  const secretSources: unknown[] = [];
  for (const v of arr(variables)) {
    if (!isObj(v)) continue;
    if (v.secret === true) {
      // Never contact a vault and never keep a value: the user re-enters it.
      out.push({ ...keyValue({ ...v, value: '' }), secret: true });
      secretSources.push({ key: str(v.key), secret: true, source: scrub(v.source) });
      ctx.report.unmodelled('secret-variable', ownerName, str(v.key));
      continue;
    }
    out.push(keyValue(v));
  }
  if (secretSources.length > 0) sidecar.variable = secretSources;
  return out;
}

// ── sidecar scrub ───────────────────────────────────────────────────────────

/**
 * Values kept only for reference: auth is kept separately (v2-shaped), and
 * every other credential is blanked with the export redactor's own walk
 * (`redactPostmanV3Raw`: credential-named subtrees of any type, credential
 * rows, URL userinfo / query secrets, prototype keys), so plaintext never
 * lands in the bag.
 */
export function scrub(value: unknown): unknown {
  if (!isObj(value)) return redactPostmanV3Raw(value);
  const { auth: _auth, credentials: _credentials, ...rest } = value;
  return redactPostmanV3Raw(rest);
}

// ── examples / schema ───────────────────────────────────────────────────────

/** HTTP response fields mapped onto the v2 saved-response shape. */
const HTTP_RESPONSE_FIELDS = new Set(['statusCode', 'statusText', 'headers', 'body']);

/**
 * Saved-response body: the HTTP body, else (gRPC `messages` / `metadata` /
 * `trailers`, GraphQL / MQTT `events`, ...) the non-HTTP response data as
 * JSON, so a non-HTTP example is not reduced to an empty body. Bodies are
 * blanked (and counted) by the export redactor like any saved response.
 */
function exampleBody(response: Raw): string {
  const body = isObj(response.body) ? response.body : {};
  if (typeof body.content === 'string') return body.content;
  if (typeof response.body === 'string') return response.body;
  const rest = Object.fromEntries(
    Object.entries(response).filter(([k]) => !HTTP_RESPONSE_FIELDS.has(k))
  );
  return Object.keys(rest).length > 0 ? JSON.stringify(rest) : '';
}

/** v3 example → v2 saved-response shape (walked by the redactor). */
export function exampleToV2(ex: unknown): unknown {
  if (!isObj(ex)) return ex;
  const request = isObj(ex.request) ? ex.request : {};
  const response = isObj(ex.response) ? ex.response : {};
  const reqBody = isObj(request.body) ? request.body : undefined;
  return {
    name: str(ex.name),
    originalRequest: {
      method: str(request.method),
      url: str(request.url),
      header: arr(request.headers),
      ...(reqBody ? { body: { mode: str(reqBody.type) } } : {}),
    },
    code: typeof response.statusCode === 'number' ? response.statusCode : undefined,
    status: str(response.statusText),
    header: arr(response.headers),
    body: exampleBody(response),
  };
}

export function keepExamples(
  raw: Raw,
  name: string,
  sidecar: PostmanSidecar,
  ctx: ParseContext
): void {
  if (Array.isArray(raw.examples) && raw.examples.length > 0) {
    sidecar.response = raw.examples.map(exampleToV2);
    ctx.report.unmodelled('saved-responses', name);
  }
}

export function keepSchema(
  raw: Raw,
  name: string,
  sidecar: PostmanSidecar,
  ctx: ParseContext
): void {
  if (isObj(raw.schema) && raw.schema.type !== 'none') {
    sidecar.schema = scrub(raw.schema);
    ctx.report.unmodelled('schema-reference', name);
  }
}

export function keepSettingsRest(
  rest: Raw | undefined,
  name: string,
  sidecar: PostmanSidecar,
  ctx: ParseContext
): void {
  if (!rest) return;
  sidecar.settings = scrub(rest);
  ctx.report.unmodelled('request-settings', name);
}
