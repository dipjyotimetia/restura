import { v4 as uuid } from 'uuid';
import { migrateScriptPmToRs } from '@/features/scripts/lib/scriptMigrations';
import type {
  AuthConfig,
  Collection,
  CollectionItem,
  Environment,
  FormDataItem,
  HttpRequest,
  KeyValue,
  RequestBody,
} from '@/types';
import { loadBrunoLang } from '../bruno-lang';
import { coerceHttpMethod, type ImportResult, type ImportWarning } from './types';

/**
 * Source for a Bruno legacy `.bru` import.
 *
 * - `single` mode: one `.bru` file's text content (a single request).
 * - `directory` mode: a Bruno workspace, expressed as a list of files with
 *   their POSIX-style relative paths (e.g. `users/get-user.bru`,
 *   `environments/dev.bru`, `bruno.json`, `collection.bru`).
 *
 * The caller is responsible for walking the disk (Electron) or the upload
 * payload (web) and producing this structure — this importer is platform-agnostic.
 */
export type BrunoSource =
  | { kind: 'directory'; entries: Array<{ relativePath: string; content: string }> }
  | { kind: 'single'; content: string };

/**
 * Bruno-specific syntax we cannot translate into Restura's `{{var}}`
 * resolver. We surface these as warnings so the user knows what they need to
 * rewrite by hand.
 */
const BRUNO_SYNTAX_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\{\{process\.env\.[\w]+\}\}/g, label: 'process.env reference' },
  { pattern: /\{\{\$res\.[\w.]+\}\}/g, label: 'response-chain reference' },
  { pattern: /\{\{\$randomInt\(\d+,\s*\d+\)\}\}/g, label: 'randomInt with range' },
];

export async function importBrunoCollection(source: BrunoSource): Promise<ImportResult> {
  const lang = await loadBrunoLang();
  const warnings: ImportWarning[] = [];

  if (source.kind === 'single') {
    const parsed = lang.bruToJsonV2(source.content) as Record<string, unknown>;
    const item = bruRequestToItem(parsed, 'Imported request', warnings);
    return {
      collection: { id: uuid(), name: 'Bruno Import', items: [item] },
      warnings,
    };
  }

  // ---------- Directory mode ----------
  const entriesByPath = new Map(source.entries.map((e) => [e.relativePath, e.content]));

  const brunoJsonRaw = entriesByPath.get('bruno.json');
  const brunoConfig = brunoJsonRaw ? safeJsonParse(brunoJsonRaw) : null;
  const collectionName =
    isRecord(brunoConfig) && typeof brunoConfig.name === 'string' && brunoConfig.name.length > 0
      ? brunoConfig.name
      : 'Bruno Collection';

  // Build folder hierarchy from relative paths.
  const items = buildItemsFromEntries(source.entries, lang.bruToJsonV2, warnings);

  // Environments — every `.bru` under `environments/`.
  const environments: Environment[] = [];
  for (const e of source.entries) {
    if (!e.relativePath.startsWith('environments/') || !e.relativePath.endsWith('.bru')) continue;
    const envName = e.relativePath.slice('environments/'.length, -'.bru'.length);
    const parsed = lang.bruToEnvJsonV2(e.content) as Record<string, unknown>;
    environments.push(bruEnvToEnvironment(envName, parsed));
  }

  // Collection-level defaults are parsed but not yet applied to items —
  // surfacing them properly (inheriting headers/auth/scripts onto every
  // descendant) is a follow-up. For now we capture collection-level vars
  // as the Collection's `variables`.
  const collectionBruRaw = entriesByPath.get('collection.bru');
  const collectionDefaults = collectionBruRaw
    ? (lang.collectionBruToJson(collectionBruRaw) as Record<string, unknown>)
    : null;
  const collectionVariables = collectionDefaults
    ? extractCollectionVariables(collectionDefaults)
    : undefined;

  const collection: Collection = {
    id: uuid(),
    name: collectionName,
    items,
    ...(collectionVariables && collectionVariables.length > 0
      ? { variables: collectionVariables }
      : {}),
  };

  return { collection, environments, warnings };
}

// ---------- Helpers ----------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/** Max folder nesting for a Bruno directory import (guards tree recursion). */
const MAX_FOLDER_DEPTH = 100;

function buildItemsFromEntries(
  entries: Array<{ relativePath: string; content: string }>,
  bruToJsonV2: (s: string) => unknown,
  warnings: ImportWarning[]
): CollectionItem[] {
  type TreeNode = {
    name: string;
    folders: Map<string, TreeNode>;
    requests: Array<{ name: string; bru: Record<string, unknown> }>;
  };
  const root: TreeNode = { name: '', folders: new Map(), requests: [] };

  for (const e of entries) {
    if (!e.relativePath.endsWith('.bru')) continue;
    if (e.relativePath === 'collection.bru') continue;
    if (e.relativePath.startsWith('environments/')) continue;
    // Folder-level meta (`folder.bru`) is ignored for now — it carries
    // folder name/auth/scripts that we can apply in a follow-up.
    if (e.relativePath.endsWith('/folder.bru') || e.relativePath === 'folder.bru') continue;

    const parts = e.relativePath.split('/');
    const fileName = parts.pop();
    if (!fileName) continue;

    // `parts` is the folder chain; `treeToItems` recurses one level per folder,
    // so bound it to keep a maliciously deep directory from overflowing the stack.
    if (parts.length > MAX_FOLDER_DEPTH) {
      throw new Error(`Bruno collection nesting exceeds the maximum depth of ${MAX_FOLDER_DEPTH}`);
    }

    let node = root;
    for (const part of parts) {
      if (!node.folders.has(part)) {
        node.folders.set(part, { name: part, folders: new Map(), requests: [] });
      }
      const next = node.folders.get(part);
      if (!next) continue;
      node = next;
    }
    const requestName = fileName.slice(0, -'.bru'.length);
    const parsed = bruToJsonV2(e.content);
    if (isRecord(parsed)) {
      node.requests.push({ name: requestName, bru: parsed });
    }
  }

  return treeToItems(root, warnings);
}

function treeToItems(
  node: {
    name: string;
    folders: Map<string, { name: string; folders: Map<string, unknown>; requests: unknown[] }>;
    requests: Array<{ name: string; bru: Record<string, unknown> }>;
  },
  warnings: ImportWarning[]
): CollectionItem[] {
  const out: CollectionItem[] = [];
  for (const folder of node.folders.values()) {
    out.push({
      id: uuid(),
      name: folder.name,
      type: 'folder',
      items: treeToItems(
        folder as unknown as {
          name: string;
          folders: Map<
            string,
            { name: string; folders: Map<string, unknown>; requests: unknown[] }
          >;
          requests: Array<{ name: string; bru: Record<string, unknown> }>;
        },
        warnings
      ),
    });
  }
  for (const r of node.requests) {
    out.push(bruRequestToItem(r.bru, r.name, warnings));
  }
  return out;
}

function bruRequestToItem(
  bru: Record<string, unknown>,
  fallbackName: string,
  warnings: ImportWarning[]
): CollectionItem {
  const meta = isRecord(bru.meta) ? bru.meta : {};
  const name = typeof meta.name === 'string' && meta.name.length > 0 ? meta.name : fallbackName;
  // Bruno's meta.type can be 'http', 'graphql', 'grpc', 'ws'. Restura's
  // bru-importer currently models everything as HttpRequest — GraphQL bodies
  // are handled inside bruToHttpRequest by detecting body.graphql, but
  // gRPC and WebSocket requests need the dedicated request types we don't
  // map yet. Warn for those (not graphql) so users see what was downgraded.
  const metaType = typeof meta.type === 'string' ? meta.type : 'http';
  if (metaType !== 'http' && metaType !== 'graphql') {
    warnings.push({
      kind: 'platform-unsupported',
      feature: `Bruno meta.type='${metaType}' (mapped to HttpRequest)`,
      requestName: name,
    });
  }
  return {
    id: uuid(),
    name,
    type: 'request',
    request: bruToHttpRequest(bru, name, warnings),
  };
}

function bruToHttpRequest(
  bru: Record<string, unknown>,
  name: string,
  warnings: ImportWarning[]
): HttpRequest {
  // Verified shape (from running bruToJsonV2 on real .bru text):
  //   meta: { name, type, seq }
  //   http: { method, url, body, auth }   // body/auth here are STRING discriminators
  //   headers: [{ name, value, enabled }]
  //   params:  [{ name, value, enabled, type: 'query' | 'path' }]
  //   body: { json?: string, xml?: string, text?: string,
  //           graphql?: { query, variables },
  //           formUrlEncoded?: [{name,value,enabled}],
  //           multipartForm?: [{name,value,enabled,type:'text'|'file',contentType}] }
  //   auth: { basic?, bearer?, apikey?, awsv4?, digest?, oauth2?, oauth1?, ntlm?, wsse? }
  //   script: { req?: string, res?: string }
  //   tests: string
  //   vars: { req?: [{name,value,enabled,local}], res?: [...] }
  const httpMeta = isRecord(bru.http) ? bru.http : {};
  const method = coerceHttpMethod(
    typeof httpMeta.method === 'string' ? httpMeta.method : 'get',
    name,
    warnings
  );
  const url = typeof httpMeta.url === 'string' ? httpMeta.url : '';

  // Detect Bruno-specific syntax in URL/body/headers and warn once per pattern.
  // Scan only the fields where these patterns can meaningfully appear; previously
  // we serialized the whole `bru` object per request, which is O(N) in body size
  // for every request. Targeted scan is constant in the number of relevant strings.
  const bodyStrings: string[] = [];
  if (isRecord(bru.body)) {
    for (const v of Object.values(bru.body)) {
      if (typeof v === 'string') bodyStrings.push(v);
    }
  }
  const headerValues = Array.isArray(bru.headers)
    ? bru.headers.filter(isRecord).map((h) => (typeof h.value === 'string' ? h.value : ''))
    : [];
  const haystacks = [url, ...headerValues, ...bodyStrings];
  const seenLabels = new Set<string>();
  for (const { pattern, label } of BRUNO_SYNTAX_PATTERNS) {
    if (seenLabels.has(label)) continue;
    for (const s of haystacks) {
      if (!s) continue;
      pattern.lastIndex = 0;
      if (pattern.test(s)) {
        warnings.push({ kind: 'bruno-syntax', pattern: label, requestName: name });
        seenLabels.add(label);
        break;
      }
    }
  }

  const headers: KeyValue[] = [];
  if (Array.isArray(bru.headers)) {
    for (const h of bru.headers) {
      if (!isRecord(h)) continue;
      headers.push({
        id: uuid(),
        key: typeof h.name === 'string' ? h.name : '',
        value: typeof h.value === 'string' ? h.value : '',
        enabled: h.enabled !== false,
      });
    }
  }

  const params: KeyValue[] = [];
  if (Array.isArray(bru.params)) {
    for (const q of bru.params) {
      if (!isRecord(q)) continue;
      // Only surface query params — `path` params are handled via `{{var}}` in the URL.
      if (q.type !== undefined && q.type !== 'query') continue;
      params.push({
        id: uuid(),
        key: typeof q.name === 'string' ? q.name : '',
        value: typeof q.value === 'string' ? q.value : '',
        enabled: q.enabled !== false,
      });
    }
  }

  const declaredAuthType = typeof httpMeta.auth === 'string' ? httpMeta.auth : undefined;
  const authBlocks = isRecord(bru.auth) ? bru.auth : undefined;

  const script = isRecord(bru.script) ? bru.script : undefined;
  const preReqScript = typeof script?.req === 'string' ? script.req : undefined;
  const postResScript = typeof script?.res === 'string' ? script.res : undefined;
  const testsBlock = typeof bru.tests === 'string' ? bru.tests : undefined;
  const testScriptParts = [postResScript, testsBlock].filter(
    (s): s is string => typeof s === 'string' && s.length > 0
  );
  const testScript =
    testScriptParts.length > 0 ? testScriptParts.join('\n\n// --- tests block ---\n\n') : undefined;

  return {
    id: uuid(),
    name,
    type: 'http',
    method,
    url,
    headers,
    params,
    body: bruBodyToInternal(bru.body),
    auth: bruAuthToInternal(authBlocks, declaredAuthType, name, warnings),
    // Bruno uses Postman's pm.* namespace; normalize to native rs.* on import.
    ...(preReqScript ? { preRequestScript: migrateScriptPmToRs(preReqScript) } : {}),
    ...(testScript ? { testScript: migrateScriptPmToRs(testScript) } : {}),
  };
}

function bruBodyToInternal(body: unknown): RequestBody {
  if (!isRecord(body)) return { type: 'none' };
  if (typeof body.json === 'string' || isRecord(body.json)) {
    const raw = typeof body.json === 'string' ? body.json : JSON.stringify(body.json);
    return { type: 'json', raw };
  }
  if (typeof body.xml === 'string') return { type: 'xml', raw: body.xml };
  if (typeof body.text === 'string') return { type: 'text', raw: body.text };
  if (isRecord(body.graphql)) {
    // Bruno splits graphql into { query, variables }. Restura's GraphQLBodyEditor
    // serializes both into a JSON envelope, so produce { query, variables } JSON.
    const gq = body.graphql;
    const query = typeof gq.query === 'string' ? gq.query : '';
    const variables = typeof gq.variables === 'string' ? gq.variables : '';
    const envelope = JSON.stringify({ query, variables });
    return { type: 'graphql', raw: envelope };
  }
  if (Array.isArray(body.formUrlEncoded)) {
    const formData: FormDataItem[] = body.formUrlEncoded.filter(isRecord).map(
      (p): FormDataItem => ({
        id: uuid(),
        key: typeof p.name === 'string' ? p.name : '',
        value: typeof p.value === 'string' ? p.value : '',
        enabled: p.enabled !== false,
        type: 'text',
      })
    );
    return { type: 'x-www-form-urlencoded', formData };
  }
  if (Array.isArray(body.multipartForm)) {
    const formData: FormDataItem[] = body.multipartForm.filter(isRecord).map((p): FormDataItem => {
      const isFile = p.type === 'file';
      let value = '';
      if (typeof p.value === 'string') value = p.value;
      else if (Array.isArray(p.value))
        value = p.value.filter((v) => typeof v === 'string').join(',');
      return {
        id: uuid(),
        key: typeof p.name === 'string' ? p.name : '',
        value,
        enabled: p.enabled !== false,
        type: isFile ? 'file' : 'text',
      };
    });
    return { type: 'form-data', formData };
  }
  if (body.file !== undefined) return { type: 'binary' };
  return { type: 'none' };
}

function bruAuthToInternal(
  authBlocks: Record<string, unknown> | undefined,
  declaredType: string | undefined,
  name: string,
  warnings: ImportWarning[]
): AuthConfig {
  if (!declaredType || declaredType === 'none' || declaredType === 'inherit') {
    return { type: 'none' };
  }
  const block = isRecord(authBlocks?.[declaredType])
    ? (authBlocks?.[declaredType] as Record<string, unknown>)
    : {};
  const str = (k: string): string => (typeof block[k] === 'string' ? (block[k] as string) : '');

  switch (declaredType) {
    case 'basic':
      return { type: 'basic', basic: { username: str('username'), password: str('password') } };
    case 'bearer':
      return { type: 'bearer', bearer: { token: str('token') } };
    case 'apikey':
      return {
        type: 'api-key',
        apiKey: {
          key: str('key'),
          value: str('value'),
          in: block.placement === 'queryparams' ? 'query' : 'header',
        },
      };
    case 'awsv4':
      return {
        type: 'aws-signature',
        awsSignature: {
          accessKey: str('accessKeyId'),
          secretKey: str('secretAccessKey'),
          region: str('region') || 'us-east-1',
          service: str('service') || 'execute-api',
        },
      };
    case 'digest':
      return { type: 'digest', digest: { username: str('username'), password: str('password') } };
    case 'oauth2': {
      const grantTypeRaw = str('grantType');
      type OAuth2Grant = NonNullable<NonNullable<AuthConfig['oauth2']>['grantType']>;
      let grantType: OAuth2Grant | undefined;
      if (grantTypeRaw === 'authorization_code') grantType = 'authorization_code';
      else if (grantTypeRaw === 'client_credentials') grantType = 'client_credentials';
      else if (grantTypeRaw === 'password') grantType = 'password';
      else if (grantTypeRaw === 'device_code' || grantTypeRaw === 'device_authorization')
        grantType = 'device_code';
      return {
        type: 'oauth2',
        oauth2: {
          accessToken: str('accessToken'),
          ...(grantType ? { grantType } : {}),
          ...(str('clientId') ? { clientId: str('clientId') } : {}),
          ...(str('clientSecret') ? { clientSecret: str('clientSecret') } : {}),
          ...(str('callbackUrl') ? { redirectUri: str('callbackUrl') } : {}),
          ...(str('authorizationUrl') ? { authorizationUrl: str('authorizationUrl') } : {}),
          ...(str('accessTokenUrl') ? { tokenUrl: str('accessTokenUrl') } : {}),
          ...(str('scope') ? { scope: str('scope') } : {}),
        },
      };
    }
    case 'oauth1': {
      const sm = str('signatureMethod');
      const signatureMethod =
        sm === 'HMAC-SHA1' || sm === 'HMAC-SHA256' || sm === 'PLAINTEXT' ? sm : undefined;
      return {
        type: 'oauth1',
        oauth1: {
          consumerKey: str('consumerKey'),
          consumerSecret: str('consumerSecret'),
          ...(str('accessToken') ? { accessToken: str('accessToken') } : {}),
          ...(str('accessTokenSecret') ? { accessTokenSecret: str('accessTokenSecret') } : {}),
          ...(signatureMethod ? { signatureMethod } : {}),
          ...(str('realm') ? { realm: str('realm') } : {}),
          ...(str('nonce') ? { nonce: str('nonce') } : {}),
          ...(str('timestamp') ? { timestamp: str('timestamp') } : {}),
        },
      };
    }
    case 'ntlm': {
      return {
        type: 'ntlm',
        ntlm: {
          username: str('username'),
          password: str('password'),
          ...(str('domain') ? { domain: str('domain') } : {}),
          ...(str('workstation') ? { workstation: str('workstation') } : {}),
        },
      };
    }
    case 'wsse': {
      return { type: 'wsse', wsse: { username: str('username'), password: str('password') } };
    }
    default:
      warnings.push({ kind: 'unsupported-auth', authType: declaredType, requestName: name });
      return { type: 'none' };
  }
}

function bruEnvToEnvironment(name: string, parsed: Record<string, unknown>): Environment {
  // Verified shape: { variables: [{ name, value, enabled, secret }] }.
  // Older sources may emit a `vars` object — handle both.
  const variables: KeyValue[] = [];
  if (Array.isArray(parsed.variables)) {
    for (const v of parsed.variables) {
      if (!isRecord(v)) continue;
      variables.push({
        id: uuid(),
        key: typeof v.name === 'string' ? v.name : '',
        value:
          typeof v.value === 'string' ? v.value : v.value == null ? '' : JSON.stringify(v.value),
        enabled: v.enabled !== false,
        ...(v.secret === true ? { secret: true } : {}),
      });
    }
  } else if (isRecord(parsed.vars)) {
    for (const [k, v] of Object.entries(parsed.vars)) {
      variables.push({
        id: uuid(),
        key: k,
        value: typeof v === 'string' ? v : JSON.stringify(v),
        enabled: true,
      });
    }
  }
  return { id: uuid(), name, variables };
}

function extractCollectionVariables(collectionDefaults: Record<string, unknown>): KeyValue[] {
  const out: KeyValue[] = [];
  const vars = isRecord(collectionDefaults.vars) ? collectionDefaults.vars : undefined;
  if (vars && Array.isArray(vars.req)) {
    for (const v of vars.req) {
      if (!isRecord(v)) continue;
      out.push({
        id: uuid(),
        key: typeof v.name === 'string' ? v.name : '',
        value: typeof v.value === 'string' ? v.value : '',
        enabled: v.enabled !== false,
      });
    }
  }
  return out;
}
