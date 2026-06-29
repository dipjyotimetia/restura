import type { ProxyBodyType, FormField } from '../../../shared/protocol/body-builder';
import type { ProtocolAuthConfig, RequestSpec } from '../../../shared/protocol/types';
import { isRecord } from '../util/oc';

export interface MappedRequest {
  spec: RequestSpec;
  /** Non-fatal limitations (e.g. an unsupported auth/body shape) to surface. */
  warnings: string[];
}

interface NameValue {
  name?: string;
  value?: string;
  enabled?: boolean;
}

/** Coerce a parsed-YAML scalar to a string. Guards against non-string body /
 *  field values (e.g. an unquoted YAML number) reaching `String.prototype`. */
function asString(v: unknown): string {
  if (v == null) return '';
  return typeof v === 'string' ? v : String(v);
}

/** Substitute `{{ key }}` references using the provided variable map. The key
 *  grammar matches the app's interpolation (any chars except `}`), so names
 *  with spaces/`$`/etc. resolve. Unknown references are left intact (the
 *  request will surface the failure). */
export function resolveVars(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key]! : match
  );
}

function collectEnabled(list: unknown, vars: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(list)) return out;
  for (const raw of list as NameValue[]) {
    if (!isRecord(raw)) continue;
    if (raw.enabled === false) continue;
    if (typeof raw.name !== 'string' || raw.name === '') continue;
    out[raw.name] = resolveVars(typeof raw.value === 'string' ? raw.value : '', vars);
  }
  return out;
}

interface BuiltBody {
  bodyType?: ProxyBodyType;
  data?: string;
  formData?: FormField[];
  warning?: string;
}

const RAW_FORMAT_TO_BODY: Record<string, ProxyBodyType> = {
  json: 'json',
  text: 'text',
  graphql: 'json',
  xml: 'raw',
  binary: 'binary',
};

function buildBody(body: unknown, vars: Record<string, string>): BuiltBody {
  if (!body) return {};
  if (Array.isArray(body)) {
    return { warning: 'Per-environment body array is not supported by Send; body omitted.' };
  }
  if (!isRecord(body)) return {};

  if (isRecord(body.raw)) {
    const raw = body.raw as { format?: string; value?: unknown };
    const bodyType = RAW_FORMAT_TO_BODY[raw.format ?? 'text'] ?? 'text';
    return { bodyType, data: resolveVars(asString(raw.value), vars) };
  }
  if (isRecord(body.graphql)) {
    return { bodyType: 'json', data: resolveVars(JSON.stringify(body.graphql), vars) };
  }
  if (isRecord(body.formUrlEncoded)) {
    const parts = (body.formUrlEncoded as { parts?: NameValue[] }).parts ?? [];
    const formData: FormField[] = parts
      .filter((p) => isRecord(p) && p.enabled !== false && typeof p.name === 'string')
      .map((p) => ({ name: p.name as string, value: resolveVars(asString(p.value), vars) }));
    return { bodyType: 'form-urlencoded', formData };
  }
  if (isRecord(body.multipartForm)) {
    return { warning: 'multipart/form-data bodies are not supported by Send yet; body omitted.' };
  }
  return { warning: 'Unrecognized body shape; body omitted.' };
}

/** Apply header/query auth that doesn't need wire signing; return any
 *  wire-signed `ProtocolAuthConfig` for executeHttpProxy plus warnings. */
function applyAuth(
  auth: unknown,
  headers: Record<string, string>,
  params: Record<string, string>,
  vars: Record<string, string>
): { wireAuth?: ProtocolAuthConfig; warnings: string[] } {
  const warnings: string[] = [];
  if (!isRecord(auth) || typeof auth.type !== 'string' || auth.type === 'none') {
    return { warnings };
  }
  const v = (s: unknown): string => resolveVars(typeof s === 'string' ? s : '', vars);

  switch (auth.type) {
    case 'basic': {
      const token = Buffer.from(`${v(auth.username)}:${v(auth.password)}`).toString('base64');
      headers['Authorization'] = `Basic ${token}`;
      return { warnings };
    }
    case 'bearer':
      headers['Authorization'] = `Bearer ${v(auth.token)}`;
      return { warnings };
    case 'apikey': {
      const key = v(auth.key);
      const value = v(auth.value);
      if (auth.placement === 'query') params[key] = value;
      else headers[key] = value;
      return { warnings };
    }
    case 'awsv4':
      return {
        warnings,
        wireAuth: {
          type: 'aws-signature',
          awsSignature: {
            accessKey: v(auth.accessKeyId),
            secretKey: v(auth.secretAccessKey),
            region: v(auth.region),
            service: v(auth.service),
          },
        },
      };
    case 'oauth1':
      return {
        warnings,
        wireAuth: {
          type: 'oauth1',
          oauth1: {
            consumerKey: v(auth.consumerKey),
            consumerSecret: v(auth.consumerSecret),
            ...(auth.accessToken ? { accessToken: v(auth.accessToken) } : {}),
            ...(auth.accessTokenSecret ? { accessTokenSecret: v(auth.accessTokenSecret) } : {}),
          },
        },
      };
    case 'wsse':
      return {
        warnings,
        wireAuth: {
          type: 'wsse',
          wsse: { username: v(auth.username), password: v(auth.password) },
        },
      };
    default:
      warnings.push(`Auth type '${auth.type}' is not supported by Send; sending without auth.`);
      return { warnings };
  }
}

/**
 * Map a parsed OpenCollection request document (`{ info, http, ... }`) to a
 * shared-protocol `RequestSpec`. Pure + vscode-free for unit testing. Throws if
 * the document isn't an http request with a method + url.
 */
export function mapHttpElementToSpec(doc: unknown, vars: Record<string, string>): MappedRequest {
  if (!isRecord(doc) || !isRecord(doc.http)) {
    throw new Error('Not an HTTP request document');
  }
  const http = doc.http;
  if (typeof http.method !== 'string' || typeof http.url !== 'string') {
    throw new Error('Request is missing http.method or http.url');
  }

  const warnings: string[] = [];
  const headers = collectEnabled(http.headers, vars);
  const params = collectEnabled(http.params, vars);

  const auth = applyAuth(http.auth, headers, params, vars);
  warnings.push(...auth.warnings);

  const built = buildBody(http.body, vars);
  if (built.warning) warnings.push(built.warning);

  const spec: RequestSpec = {
    method: http.method,
    url: resolveVars(http.url, vars),
    headers,
    params,
    ...(built.bodyType ? { bodyType: built.bodyType } : {}),
    ...(built.data !== undefined ? { data: built.data } : {}),
    ...(built.formData ? { formData: built.formData } : {}),
    ...(auth.wireAuth ? { auth: auth.wireAuth } : {}),
  };

  return { spec, warnings };
}
