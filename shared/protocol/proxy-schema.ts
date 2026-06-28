import { z } from 'zod';
import { protocolSecretValueSchema, isProtocolSecretHandle } from './secret-value-schema';

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
 * The structural types (`ProxyBodyType`, `FormField`, `ProtocolAuthConfig`)
 * live in `body-builder.ts` / `types.ts`; the schema is kept consistent
 * with those module-level unions. If a new field is added there, mirror
 * it here.
 */

/** Mirrors `ProxyBodyType` from `./body-builder.ts`. Guarded by `tests/body-type-parity.test.ts`. */
export const BodyTypeSchema = z.enum([
  'none',
  'json',
  'text',
  'raw',
  'form-urlencoded',
  'form-data',
  'binary',
]);

/** Mirrors `FormField` from `./body-builder.ts`. Guarded by `tests/body-type-parity.test.ts`. */
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
 *
 * Guarded by `tests/auth-config-parity.test.ts` (renderer ↔ protocol ↔ schema).
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
      secretKey: protocolSecretValueSchema,
      region: z.string(),
      service: z.string(),
    })
    .optional(),
  oauth1: z
    .object({
      consumerKey: z.string(),
      consumerSecret: protocolSecretValueSchema,
      accessToken: protocolSecretValueSchema.optional(),
      accessTokenSecret: protocolSecretValueSchema.optional(),
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
      password: protocolSecretValueSchema,
      domain: z.string().optional(),
      workstation: z.string().optional(),
    })
    .optional(),
  wsse: z
    .object({
      username: z.string(),
      password: protocolSecretValueSchema,
      passwordType: z.enum(['PasswordDigest', 'PasswordText']).optional(),
    })
    .optional(),
});

/**
 * Returns true iff the auth descriptor carries a `{ kind: 'handle' }`
 * SecretValue anywhere. The Worker uses this to fail fast with a 400 — there's
 * no OS keychain available in a Worker runtime to resolve the handle against,
 * so the request would silently send empty credentials otherwise.
 */
export function containsAuthHandle(
  auth: z.infer<typeof ProtocolAuthConfigSchema> | undefined
): boolean {
  if (!auth) return false;
  const aws = auth.awsSignature;
  if (aws && isProtocolSecretHandle(aws.secretKey)) return true;
  const o1 = auth.oauth1;
  if (
    o1 &&
    (isProtocolSecretHandle(o1.consumerSecret) ||
      isProtocolSecretHandle(o1.accessToken) ||
      isProtocolSecretHandle(o1.accessTokenSecret))
  ) {
    return true;
  }
  if (auth.ntlm && isProtocolSecretHandle(auth.ntlm.password)) return true;
  if (auth.wsse && isProtocolSecretHandle(auth.wsse.password)) return true;
  return false;
}

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
 * Redirect policy passed alongside a request. Mirrors RedirectPolicy in
 * shared/protocol/types.ts. All fields optional — absent means "default".
 * Guarded by `tests/redirect-policy-parity.test.ts`.
 */
export const RedirectPolicySchema = z.object({
  followOriginalMethod: z.boolean().optional(),
  followAuthHeader: z.boolean().optional(),
  stripReferer: z.boolean().optional(),
  // 0 = "do not follow" (honoured by the redirect-follower); 1..50 = hop cap.
  maxRedirects: z.number().int().min(0).max(50).optional(),
});

export const ProxyRequestBodySchema = z.object({
  // Permissive on method: `executeHttpProxy` enforces its own `ALLOWED_METHODS`
  // allow-list, so the precise 400 message comes from there, not from Zod.
  method: z.string().min(1),
  url: z.string().min(1).max(2048),
  headers: z.record(z.string(), z.string()).optional(),
  params: z.record(z.string(), z.string()).optional(),
  bodyType: BodyTypeSchema.optional(),
  // 50 MB request-body cap — a boundary check independent of the 10 MB
  // response cap (`MAX_RESPONSE_SIZE`) in http-proxy.ts.
  data: z
    .string()
    .max(50 * 1024 * 1024)
    .optional(),
  formData: z.array(FormFieldSchema).optional(),
  timeout: z.number().int().min(0).max(300_000).optional(),
  upstreamProxy: UpstreamProxyConfigSchema.optional(),
  auth: ProtocolAuthConfigSchema.optional(),
  streamingMode: z.boolean().optional(),
  // Per-request redirect + URL handling (cross-platform).
  redirectPolicy: RedirectPolicySchema.optional(),
  encodeUrl: z.boolean().optional(),
  /**
   * Desktop-only TLS fields. The Worker rejects requests carrying any of
   * these with a 400 — they're inert at the Cloudflare runtime layer.
   * Accepted by the schema so the renderer can ship one shape to both
   * harnesses; the rejection happens in the handler.
   */
  serverCipherOrder: z.boolean().optional(),
  minTlsVersion: z.enum(['TLSv1', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3']).optional(),
  cipherSuites: z.string().optional(),
});

export type ProxyRequestBody = z.infer<typeof ProxyRequestBodySchema>;
export type UpstreamProxyConfig = z.infer<typeof UpstreamProxyConfigSchema>;
