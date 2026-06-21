/**
 * Bruno `.bru` exporter — inverse of `importers/bruno.ts`.
 *
 * Strategy: convert a Restura `Collection` to the JSON shape `@usebruno/lang`
 * accepts, then pipe each request through `jsonToBruV2` and each environment
 * through `envJsonToBruV2`. The shape is verified by running `bruToJsonV2` on
 * real `.bru` text (see the importer's comment block for the schema).
 *
 * Result is a `BrunoExport` value that mirrors the importer's `BrunoSource`,
 * so round-trip is `BrunoSource → importBrunoCollection → ... → exportBrunoCollection → BrunoExport`.
 *
 * `@usebruno/lang` is CommonJS and ~400KB — load it lazily so a renderer that
 * never exports to Bruno doesn't pay the bundle cost.
 */

import type {
  AuthConfig,
  Collection,
  CollectionItem,
  Environment,
  HttpRequest,
  KeyValue,
  RequestBody,
} from '@/types';
import type { SecretValue } from '@/lib/shared/secretRef';
import { loadBrunoLang } from './bruno-lang';

/**
 * Bruno's `.bru` format is text-only — render handles as `{{handle:<label>}}`
 * placeholders so the export carries a reference without leaking plaintext.
 */
function brunoSecretValue(value: SecretValue | undefined): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  if (value.kind === 'inline') return value.value;
  return `{{handle:${value.label ?? value.id}}}`;
}

/**
 * Warnings surfaced by the exporter when an item couldn't be represented
 * cleanly in Bruno's `.bru` format. Callers (the Sidebar export UI in
 * particular) should display these so the user knows what survived the
 * round-trip and what didn't.
 *
 * Today the dominant case is non-HTTP protocols: Bruno's `.bru` schema is
 * HTTP-only at v2, so gRPC/WebSocket/SSE/MCP requests are exported as
 * URL-only stubs and won't be runnable from Bruno. The auth case fires
 * when `strict: false` (default) silently dropped an auth descriptor
 * Bruno doesn't recognise.
 */
export interface BrunoExportWarning {
  kind: 'non-http-request' | 'unsupported-auth';
  /** Bruno-relative path to the affected file (or '' for collection-level). */
  path: string;
  /** Short human-readable explanation. */
  message: string;
}

/** A Restura collection serialised as Bruno workspace files. */
export type BrunoExport =
  | {
      kind: 'directory';
      entries: Array<{ relativePath: string; content: string }>;
      warnings: BrunoExportWarning[];
    }
  | { kind: 'single'; content: string; warnings: BrunoExportWarning[] };

export interface ExportBrunoOptions {
  /** Optional environments to include under `environments/<name>.bru`. */
  environments?: Environment[];
  /** Strict mode: throw on unrepresentable items. Default: `false` (warn-only). */
  strict?: boolean;
}

/**
 * Single-request convenience — exports just one HTTP request as a `.bru` text.
 */
export async function exportBrunoRequest(request: HttpRequest): Promise<string> {
  const lang = await loadBrunoLang();
  const json = httpRequestToBruJson(request, request.name || 'request', 1);
  return lang.jsonToBruV2(json);
}

/** Bruno's `.bru` schema is HTTP-only as of v2 — flag non-HTTP requests. */
function nonHttpWarning(name: string, type: string, path: string): BrunoExportWarning {
  return {
    kind: 'non-http-request',
    path,
    message: `Request "${name}" is type "${type}". Bruno only supports HTTP — exported as a URL-only stub; protocol-specific data (proto, schema, subscription frames, MCP messages) was dropped.`,
  };
}

/**
 * Full collection export — produces a directory layout matching Bruno's
 * filesystem layout. Returns a structure the caller can write to disk
 * (Electron) or zip into a download blob (web).
 */
export async function exportBrunoCollection(
  collection: Collection,
  opts: ExportBrunoOptions = {}
): Promise<BrunoExport> {
  const lang = await loadBrunoLang();
  const entries: Array<{ relativePath: string; content: string }> = [];
  const warnings: BrunoExportWarning[] = [];

  // bruno.json — minimal config
  entries.push({
    relativePath: 'bruno.json',
    content: JSON.stringify(
      {
        version: '1',
        name: collection.name,
        type: 'collection',
      },
      null,
      2
    ),
  });

  // collection.bru — top-level defaults
  const collectionBruJson: Record<string, unknown> = {};
  if (collection.variables && collection.variables.length > 0) {
    collectionBruJson.vars = {
      req: collection.variables.map((v, i) => ({
        name: v.key,
        value: v.value,
        enabled: v.enabled !== false,
        local: false,
        ...(v.id ? {} : { _idx: i }),
      })),
    };
  }
  if (collection.auth && collection.auth.type !== 'none') {
    const ba = authToBruno(collection.auth, opts.strict ?? false);
    if (ba) {
      collectionBruJson.auth = ba.blocks;
      collectionBruJson.http = { auth: ba.discriminator };
    }
  }
  if (Object.keys(collectionBruJson).length > 0) {
    entries.push({
      relativePath: 'collection.bru',
      content: lang.jsonToCollectionBru(collectionBruJson),
    });
  }

  // Environments under environments/<name>.bru
  for (const env of opts.environments ?? []) {
    const envJson = environmentToBrunoJson(env);
    const safeName = sanitiseFileName(env.name);
    entries.push({
      relativePath: `environments/${safeName}.bru`,
      content: lang.envJsonToBruV2(envJson),
    });
  }

  // Walk the item tree, emitting one .bru file per request.
  let seq = 1;
  const writeItems = (items: CollectionItem[], folderPath: string) => {
    for (const item of items) {
      if (item.type === 'folder') {
        const folderSlug = sanitiseFileName(item.name);
        const nextPath = folderPath ? `${folderPath}/${folderSlug}` : folderSlug;
        writeItems(item.items ?? [], nextPath);
      } else if (item.request) {
        const req = item.request;
        const fileName = sanitiseFileName(item.name);
        const relPath = folderPath ? `${folderPath}/${fileName}.bru` : `${fileName}.bru`;
        // Only HTTP requests round-trip cleanly through V2. gRPC/WebSocket/SSE/MCP
        // each have their own runtime model in Restura, but Bruno's `.bru` schema
        // can only represent HTTP. Emit a URL-only stub AND surface a warning so
        // the user knows the export is lossy. In strict mode the warning becomes
        // a thrown error.
        if (req.type !== 'http') {
          const message = nonHttpWarning(item.name, req.type, relPath);
          if (opts.strict) {
            throw new Error(message.message);
          }
          warnings.push(message);
          const stub = nonHttpRequestStub(item.name, req, seq++);
          entries.push({ relativePath: relPath, content: lang.jsonToBruV2(stub) });
          continue;
        }
        const json = httpRequestToBruJson(req as HttpRequest, item.name, seq++);
        entries.push({ relativePath: relPath, content: lang.jsonToBruV2(json) });
      }
    }
  };

  writeItems(collection.items, '');
  return { kind: 'directory', entries, warnings };
}

// ---------------------------------------------------------------------------
// HTTP request → Bruno JSON
// ---------------------------------------------------------------------------

function httpRequestToBruJson(
  request: HttpRequest,
  fallbackName: string,
  seq: number
): Record<string, unknown> {
  const name = request.name || fallbackName;
  const method = (request.method || 'GET').toLowerCase();

  const body = request.body ?? { type: 'none' };
  const { bodyJson, bodyDiscriminator } = bodyToBruno(body);
  const auth = authToBruno(request.auth, false);

  const json: Record<string, unknown> = {
    meta: { name, type: 'http', seq },
    http: {
      method,
      url: request.url,
      ...(bodyDiscriminator ? { body: bodyDiscriminator } : {}),
      ...(auth ? { auth: auth.discriminator } : {}),
    },
    ...(request.params && request.params.length > 0
      ? {
          params: request.params.map((p) => ({
            name: p.key,
            value: p.value,
            enabled: p.enabled !== false,
            type: 'query',
          })),
        }
      : {}),
    ...(request.headers && request.headers.length > 0
      ? {
          headers: request.headers.map((h) => ({
            name: h.key,
            value: h.value,
            enabled: h.enabled !== false,
          })),
        }
      : {}),
    ...(bodyJson !== undefined ? { body: bodyJson } : {}),
    ...(auth ? { auth: auth.blocks } : {}),
    ...(request.preRequestScript || request.testScript
      ? {
          script: {
            ...(request.preRequestScript ? { req: request.preRequestScript } : {}),
            ...(request.testScript ? { res: request.testScript } : {}),
          },
        }
      : {}),
  };

  return json;
}

function bodyToBruno(body: RequestBody): {
  bodyJson?: Record<string, unknown>;
  bodyDiscriminator?: string;
} {
  switch (body.type) {
    case 'none':
      return {};
    case 'json':
      return { bodyJson: { json: body.raw ?? '' }, bodyDiscriminator: 'json' };
    case 'xml':
      return { bodyJson: { xml: body.raw ?? '' }, bodyDiscriminator: 'xml' };
    case 'text':
      return { bodyJson: { text: body.raw ?? '' }, bodyDiscriminator: 'text' };
    case 'graphql': {
      // Restura stores the GraphQL body as a JSON envelope `{query, variables}`.
      const raw = body.raw ?? '';
      let query = '';
      let variables = '';
      try {
        const parsed = JSON.parse(raw) as { query?: unknown; variables?: unknown };
        query = typeof parsed.query === 'string' ? parsed.query : '';
        if (typeof parsed.variables === 'string') variables = parsed.variables;
        else if (parsed.variables !== undefined) variables = JSON.stringify(parsed.variables);
      } catch {
        query = raw;
      }
      return {
        bodyJson: { graphql: { query, variables } },
        bodyDiscriminator: 'graphql',
      };
    }
    case 'x-www-form-urlencoded':
      return {
        bodyJson: {
          formUrlEncoded: (body.formData ?? []).map((f) => ({
            name: f.key,
            value: f.value,
            enabled: f.enabled !== false,
          })),
        },
        bodyDiscriminator: 'formUrlEncoded',
      };
    case 'form-data':
      return {
        bodyJson: {
          multipartForm: (body.formData ?? []).map((f) => ({
            name: f.key,
            value: f.value,
            enabled: f.enabled !== false,
            type: f.type === 'file' ? 'file' : 'text',
          })),
        },
        bodyDiscriminator: 'multipartForm',
      };
    case 'binary':
      return { bodyJson: { file: [] }, bodyDiscriminator: 'file' };
    default:
      return {};
  }
}

function authToBruno(
  auth: AuthConfig,
  strict: boolean
): { blocks: Record<string, unknown>; discriminator: string } | null {
  switch (auth.type) {
    case 'none':
      return null;
    case 'basic':
      return {
        blocks: {
          basic: {
            username: auth.basic?.username ?? '',
            password: brunoSecretValue(auth.basic?.password),
          },
        },
        discriminator: 'basic',
      };
    case 'bearer':
      return {
        blocks: { bearer: { token: brunoSecretValue(auth.bearer?.token) } },
        discriminator: 'bearer',
      };
    case 'api-key':
      return {
        blocks: {
          apikey: {
            key: auth.apiKey?.key ?? '',
            value: brunoSecretValue(auth.apiKey?.value),
            placement: auth.apiKey?.in === 'query' ? 'queryparams' : 'header',
          },
        },
        discriminator: 'apikey',
      };
    case 'aws-signature':
      return {
        blocks: {
          awsv4: {
            accessKeyId: auth.awsSignature?.accessKey ?? '',
            secretAccessKey: brunoSecretValue(auth.awsSignature?.secretKey),
            region: auth.awsSignature?.region ?? '',
            service: auth.awsSignature?.service ?? '',
          },
        },
        discriminator: 'awsv4',
      };
    case 'digest':
      return {
        blocks: {
          digest: {
            username: auth.digest?.username ?? '',
            password: brunoSecretValue(auth.digest?.password),
          },
        },
        discriminator: 'digest',
      };
    case 'oauth2': {
      const o = auth.oauth2;
      const accessToken = brunoSecretValue(o?.accessToken);
      const clientSecret = brunoSecretValue(o?.clientSecret);
      return {
        blocks: {
          oauth2: {
            ...(o?.grantType ? { grantType: o.grantType } : {}),
            ...(accessToken ? { accessToken } : {}),
            ...(o?.clientId ? { clientId: o.clientId } : {}),
            ...(clientSecret ? { clientSecret } : {}),
            ...(o?.redirectUri ? { callbackUrl: o.redirectUri } : {}),
            ...(o?.authorizationUrl ? { authorizationUrl: o.authorizationUrl } : {}),
            ...(o?.tokenUrl ? { accessTokenUrl: o.tokenUrl } : {}),
            ...(o?.scope ? { scope: o.scope } : {}),
          },
        },
        discriminator: 'oauth2',
      };
    }
    case 'oauth1': {
      const o = auth.oauth1 ?? { consumerKey: '', consumerSecret: '' };
      const accessToken = brunoSecretValue(o.accessToken);
      const accessTokenSecret = brunoSecretValue(o.accessTokenSecret);
      return {
        blocks: {
          oauth1: {
            consumerKey: o.consumerKey ?? '',
            consumerSecret: brunoSecretValue(o.consumerSecret),
            ...(accessToken ? { accessToken } : {}),
            ...(accessTokenSecret ? { accessTokenSecret } : {}),
            ...(o.signatureMethod ? { signatureMethod: o.signatureMethod } : {}),
            ...(o.realm ? { realm: o.realm } : {}),
          },
        },
        discriminator: 'oauth1',
      };
    }
    case 'ntlm':
      return {
        blocks: {
          ntlm: {
            username: auth.ntlm?.username ?? '',
            password: brunoSecretValue(auth.ntlm?.password),
            ...(auth.ntlm?.domain ? { domain: auth.ntlm.domain } : {}),
            ...(auth.ntlm?.workstation ? { workstation: auth.ntlm.workstation } : {}),
          },
        },
        discriminator: 'ntlm',
      };
    case 'wsse':
      return {
        blocks: {
          wsse: {
            username: auth.wsse?.username ?? '',
            password: brunoSecretValue(auth.wsse?.password),
          },
        },
        discriminator: 'wsse',
      };
    default: {
      if (strict) {
        throw new Error(
          `Bruno export does not support auth type '${(auth as { type: string }).type}'`
        );
      }
      return null;
    }
  }
}

function nonHttpRequestStub(
  name: string,
  req: Collection['items'][number]['request'],
  seq: number
): Record<string, unknown> {
  // Preserve URL for everything that has one — Bruno will at least round-trip
  // the name and URL even if it can't run the request.
  const url =
    req && 'url' in req && typeof (req as { url?: unknown }).url === 'string'
      ? (req as { url: string }).url
      : '';
  const type = req?.type ?? 'http';
  return {
    meta: { name, type, seq },
    http: { method: 'get', url },
  };
}

function environmentToBrunoJson(env: Environment): Record<string, unknown> {
  return {
    variables: (env.variables ?? []).map((v: KeyValue) => ({
      name: v.key,
      value: v.value,
      enabled: v.enabled !== false,
      ...(v.secret ? { secret: true } : {}),
    })),
  };
}

function sanitiseFileName(name: string): string {
  // Bruno filenames must not contain `/`, `\`, `:`, `*`, `?`, `"`, `<`, `>`, `|`.
  // Replace each with `_`. Collapse runs of underscores and trim.
  return (
    name
      .replace(/[/\\:*?"<>|]/g, '_')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '') || 'untitled'
  );
}
