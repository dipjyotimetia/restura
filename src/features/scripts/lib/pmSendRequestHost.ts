/**
 * Renderer-side host bridge for `pm.sendRequest`. Converts the
 * sandboxed `PmSendRequestInput` shape into a `ProxyRequestBody` and
 * fires it through the same `executeProxiedRequest` path a top-level
 * send uses — so SSRF guards, header policy, and auth all apply.
 *
 * Two behaviours that match Postman v12 semantics and weren't in v1
 * of this file:
 *  - Variable substitution: `{{var}}` references inside the URL,
 *    header values, and string body are resolved against the same
 *    `envVars` map the parent request used. Captured at construction
 *    via the `resolveVars` closure so a single sub-request only sees
 *    one consistent snapshot.
 *  - Header inheritance: the parent request's *outgoing* headers
 *    (Authorization, X-API-Key, etc. — the result of running the
 *    auth descriptor against the URL) are merged in as defaults.
 *    User-supplied headers in the sendRequest input win on collision.
 *    Matches Newman's behaviour where sub-requests inside a script
 *    pick up the collection-level auth automatically.
 *
 * Returned to the executor's `host.sendRequest` slot; the executor's
 * `pm.sendRequest` native binding wraps the response in a Postman-shaped
 * object inside QuickJS.
 */

import { checkHttpMethod } from '@shared/protocol/http-method';
import type { ProxyRequestBody } from '@shared/protocol/proxy-schema';
import { SecretVariableReferenceError } from '@shared/variables/secret-variable-token';
import { scanVariableTokens } from '@shared/variables/tokens';
import { injectString } from '@/features/workflows/lib/variableHelpers';
import { withoutSecretNames } from '@/lib/shared/resolveRequestScope';
import { executeProxiedRequest } from '@/lib/shared/transport';
import type { PmSendRequestInput, PmSubResponse } from './scriptExecutor';

function inferBody(body: unknown): { bodyType?: ProxyRequestBody['bodyType']; data?: string } {
  if (body == null) return {};
  if (typeof body === 'string') {
    // Heuristic: looks like JSON → tag as application/json so the
    // downstream proxy serializes appropriately. The user can always
    // pass an explicit Content-Type header to override.
    const trimmed = body.trimStart();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      return { bodyType: 'json', data: body };
    }
    return { bodyType: 'raw', data: body };
  }
  if (typeof body === 'object') {
    return { bodyType: 'json', data: JSON.stringify(body) };
  }
  return { bodyType: 'raw', data: String(body) };
}

export interface MakeRendererSendRequestOptions {
  /** Live variable map (env + collection + iteration row, merged). */
  variables?: Record<string, string>;
  /**
   * Default headers inherited by sub-requests — typically the parent
   * request's outgoing headers (auth + content-type). User-supplied
   * headers in `pm.sendRequest(input)` win on collision.
   */
  inheritedHeaders?: Record<string, string>;
  /** The parent's URL as sent. Headers are inherited only on its origin. */
  parentUrl?: string;
  /** The parent's URL before it is built, for `inheritedHeaderTemplates`. */
  parentUrlTemplate?: string;
  /**
   * Parent headers not resolved yet (a pre-request script runs before the parent
   * is built). Non-secret variables resolve; a secret token stays literal.
   */
  inheritedHeaderTemplates?: Record<string, string>;
  /** Names this host never resolves: script strings cannot be told from server values. */
  secretNames?: readonly string[];
  /**
   * Parent abort signal. A user-cancelled top-level send also cancels
   * any in-flight `pm.sendRequest` sub-requests.
   */
  signal?: AbortSignal;
}

/** An origin to compare, or undefined for anything that cannot be compared. */
function originOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    const { origin } = new URL(url);
    return origin === 'null' ? undefined : origin;
  } catch {
    return undefined;
  }
}

function resolveAll(
  obj: Record<string, string> | undefined,
  resolve: (s: string) => string
): Record<string, string> {
  if (!obj) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = resolve(v);
  return out;
}

/**
 * Build the renderer's `host.sendRequest` closure. Captures the
 * variable map, inherited headers, and abort signal once so every
 * sub-request fired from a single script eval sees the same snapshot.
 */
export function makeRendererSendRequest(
  options: MakeRendererSendRequestOptions = {}
): (input: PmSendRequestInput) => Promise<PmSubResponse> {
  const variables = options.variables ?? {};
  const inherited = options.inheritedHeaders ?? {};
  const secretNames = options.secretNames ?? [];
  const resolveText = (text: string, field: string): string => {
    const written = scanVariableTokens(text).find(({ name }) => secretNames.includes(name));
    if (written) {
      throw new SecretVariableReferenceError(
        'pm.sendRequest',
        written.name,
        field,
        'pm.sendRequest does not resolve secret variables.'
      );
    }
    return injectString(text, variables, secretNames);
  };

  return async (input) => {
    // Same policy as the shared core (#857): any RFC 9110 token, verbatim;
    // denied methods and non-tokens refused before any dispatch, with the
    // policy's own reason (non-token vs. not allowed).
    const methodCheck = checkHttpMethod(input.method ?? 'GET');
    if (!methodCheck.ok) {
      throw new Error(`pm.sendRequest: ${methodCheck.error}`);
    }
    const method = methodCheck.method;
    const url = resolveText(input.url, 'the URL');
    const secretFree = withoutSecretNames(variables, secretNames);
    const parentOrigin = originOf(
      options.parentUrl ??
        (options.parentUrlTemplate === undefined
          ? undefined
          : injectString(options.parentUrlTemplate, secretFree))
    );
    // Anything that cannot be compared counts as another origin.
    const sameOrigin = parentOrigin !== undefined && parentOrigin === originOf(url);
    const inheritedHeaders = sameOrigin
      ? {
          ...resolveAll(options.inheritedHeaderTemplates, (text) => injectString(text, secretFree)),
          ...inherited,
        }
      : {};
    // Merge order: inherited (lowest), user-supplied (highest). Inherited headers
    // already went through the parent's resolver and are sent as they are. The
    // script's own `"Bearer {{token}}"` is legitimate Postman idiom.
    const mergedHeaders: Record<string, string> = {
      ...inheritedHeaders,
      ...resolveAll(input.headers, (text) => resolveText(text, 'a header')),
    };
    // Inherited headers follow a redirect only as far as they would be inherited.
    const scriptSet = new Set(Object.keys(input.headers ?? {}).map((name) => name.toLowerCase()));
    const inheritedOnly = Object.keys(inheritedHeaders).filter(
      (name) => !scriptSet.has(name.toLowerCase())
    );
    const bodyShape = inferBody(
      typeof input.body === 'string' ? resolveText(input.body, 'the body') : input.body
    );
    const spec: ProxyRequestBody = {
      url,
      method,
      headers: mergedHeaders,
      ...(bodyShape.bodyType !== undefined && { bodyType: bodyShape.bodyType }),
      ...(bodyShape.data !== undefined && { data: bodyShape.data }),
      ...(inheritedOnly.length > 0 && {
        redirectPolicy: { stripOnOriginChange: inheritedOnly },
      }),
    };
    const started = Date.now();
    const proxy = await executeProxiedRequest(
      spec,
      options.signal ? { signal: options.signal } : {}
    );
    const bodyString = typeof proxy.data === 'string' ? proxy.data : JSON.stringify(proxy.data);
    return {
      code: proxy.status,
      status: proxy.statusText ?? '',
      headers: proxy.headers as Record<string, string>,
      ...(proxy.setCookies !== undefined ? { setCookies: proxy.setCookies } : {}),
      body: bodyString,
      responseTime: Date.now() - started,
      responseSize: proxy.size ?? bodyString.length,
    };
  };
}
