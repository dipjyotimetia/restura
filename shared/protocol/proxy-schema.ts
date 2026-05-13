import { z } from 'zod';

/**
 * Zod schema for the JSON body POSTed to `/api/proxy` (HTTP proxy).
 *
 * This is the wire-shape contract between the renderer's
 * `executeViaCorsProxy` / `executeStreamingRequest` and the Worker's
 * `proxy` handler. The Worker uses this schema via `parseJsonBody` to
 * validate every incoming body at the boundary — Hono's
 * `c.req.json<T>()` is only a TypeScript cast, so without this we'd
 * trust whatever shape arrives.
 *
 * The structural types (`BodyType`, `FormField`, `ProtocolAuthConfig`)
 * live in `body-builder.ts` / `types.ts`; the schema is kept consistent
 * with those module-level unions. If a new field is added there, mirror
 * it here.
 */

/** Mirrors `BodyType` from `./body-builder.ts`. */
export const BodyTypeSchema = z.enum([
  'none',
  'json',
  'text',
  'raw',
  'form-urlencoded',
  'form-data',
  'binary',
]);

/** Mirrors `FormField` from `./body-builder.ts`. */
export const FormFieldSchema = z.object({
  name: z.string(),
  value: z.string(),
  filename: z.string().optional(),
  contentType: z.string().optional(),
});

/**
 * Mirrors `ProtocolAuthConfig` from `./types.ts`. Only the auth shapes the
 * shared protocol core actually consumes are validated structurally; the
 * `type` discriminator accepts the full union so renderer-side auth types
 * (basic/bearer/etc) still pass through as no-ops.
 */
export const ProtocolAuthConfigSchema = z.object({
  type: z.enum([
    'none',
    'basic',
    'bearer',
    'api-key',
    'oauth2',
    'digest',
    'aws-signature',
    'oauth1',
    'ntlm',
    'wsse',
  ]),
  awsSignature: z
    .object({
      accessKey: z.string(),
      secretKey: z.string(),
      region: z.string(),
      service: z.string(),
    })
    .optional(),
  oauth1: z
    .object({
      consumerKey: z.string(),
      consumerSecret: z.string(),
      accessToken: z.string().optional(),
      accessTokenSecret: z.string().optional(),
      signatureMethod: z.enum(['HMAC-SHA1', 'HMAC-SHA256', 'PLAINTEXT']).optional(),
      realm: z.string().optional(),
      nonce: z.string().optional(),
      timestamp: z.string().optional(),
      addParamsToBody: z.boolean().optional(),
    })
    .optional(),
  ntlm: z
    .object({
      username: z.string(),
      password: z.string(),
      domain: z.string().optional(),
      workstation: z.string().optional(),
    })
    .optional(),
  wsse: z
    .object({
      username: z.string(),
      password: z.string(),
      passwordType: z.enum(['PasswordDigest', 'PasswordText']).optional(),
    })
    .optional(),
});

/**
 * Mirrors the Worker's local `UpstreamProxyConfig` interface. The host
 * regex matches `buildFetcher`'s pre-existing illegal-character guard so
 * an invalid host fails fast at the JSON boundary, not later inside the
 * fetcher (where it would surface as a 5xx instead of a 4xx).
 */
export const UpstreamProxyConfigSchema = z.object({
  host: z.string().regex(/^[a-zA-Z0-9.\-[\]:]+$/, 'Invalid proxy host'),
  port: z.number().int().min(1).max(65535),
  auth: z.object({ username: z.string(), password: z.string() }).optional(),
});

/**
 * The proxy handler accepts any standard HTTP method; `executeHttpProxy`
 * already rejects the dangerous ones (TRACE/CONNECT). We keep the schema
 * permissive on method and let `validateMethod` in `http-proxy.ts` do the
 * allow-list filtering — that way the 400 message stays consistent with
 * pre-Zod behaviour.
 */
export const ProxyRequestBodySchema = z.object({
  method: z.string().min(1),
  url: z.string().min(1).max(2048),
  headers: z.record(z.string(), z.string()).optional(),
  params: z.record(z.string(), z.string()).optional(),
  bodyType: BodyTypeSchema.optional(),
  // 50 MB cap matches MAX_REQUEST_BODY_SIZE in http-proxy.ts.
  data: z.string().max(50 * 1024 * 1024).optional(),
  formData: z.array(FormFieldSchema).optional(),
  timeout: z.number().int().min(0).max(300_000).optional(),
  upstreamProxy: UpstreamProxyConfigSchema.optional(),
  auth: ProtocolAuthConfigSchema.optional(),
  streamingMode: z.boolean().optional(),
});

export type ProxyRequestBody = z.infer<typeof ProxyRequestBodySchema>;
export type UpstreamProxyConfig = z.infer<typeof UpstreamProxyConfigSchema>;
