import { z } from 'zod';

const description = z.union([
  z.string(),
  z.object({ content: z.string(), mimeType: z.string().optional() }),
]);

const author = z.object({
  name: z.string().optional(),
  email: z.string().optional(),
  url: z.string().optional(),
});

const info = z.object({
  name: z.string().min(1),
  summary: z.string().optional(),
  version: z.string().optional(),
  authors: z.array(author).optional(),
});

const variableValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const variable = z.object({
  name: z.string(),
  value: z
    .union([
      variableValue,
      z.array(z.object({ name: z.string().optional(), value: variableValue })),
    ])
    .optional(),
  description: description.optional(),
  disabled: z.boolean().optional(),
});

const secretVariable = z.object({
  secret: z.literal(true),
  name: z.string(),
  type: z.enum(['string', 'number', 'boolean']).optional(),
  description: description.optional(),
  disabled: z.boolean().optional(),
});

const environment = z.object({
  name: z.string().min(1),
  color: z.string().optional(),
  description: description.optional(),
  // secretVariable must come first: it requires `secret: true`, so ordinary
  // variables still fall through to `variable`. With `variable` first, Zod
  // matched it for secret variables too and stripped the `secret` flag.
  variables: z.array(z.union([secretVariable, variable])).optional(),
  clientCertificates: z.array(z.unknown()).optional(),
  extends: z.string().optional(),
  dotEnvFilePath: z.string().optional(),
});

const httpHeader = z.object({
  name: z.string(),
  value: z.string(),
  enabled: z.boolean().optional(),
  description: description.optional(),
});

const httpParam = z.object({
  name: z.string(),
  value: z.string(),
  enabled: z.boolean().optional(),
  description: description.optional(),
});

// NOTE: discriminator literals match the upstream OpenCollection v1.0.0 schema
// exactly: apikey (lowercase), awsv4, oauth1, oauth2, etc.
const auth = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('basic'), username: z.string(), password: z.string() }),
  z.object({ type: z.literal('bearer'), token: z.string() }),
  z.object({
    type: z.literal('apikey'),
    key: z.string(),
    value: z.string(),
    placement: z.enum(['header', 'query']),
  }),
  z.object({ type: z.literal('digest'), username: z.string(), password: z.string() }),
  z.object({
    type: z.literal('ntlm'),
    username: z.string(),
    password: z.string(),
    domain: z.string().optional(),
  }),
  z.object({
    type: z.literal('oauth1'),
    consumerKey: z.string(),
    consumerSecret: z.string(),
    accessToken: z.string().optional(),
    accessTokenSecret: z.string().optional(),
  }),
  z.object({ type: z.literal('oauth2') }).passthrough(),
  z.object({
    type: z.literal('awsv4'),
    accessKeyId: z.string(),
    secretAccessKey: z.string(),
    region: z.string(),
    service: z.string(),
    sessionToken: z.string().optional(),
  }),
  z.object({ type: z.literal('wsse'), username: z.string(), password: z.string() }),
]);

const httpRequestBody = z.object({}).passthrough();

const httpRequestDetails = z.object({
  method: z.string(),
  url: z.string(),
  headers: z.array(httpHeader).optional(),
  params: z.array(httpParam).optional(),
  body: z.union([httpRequestBody, z.array(httpRequestBody)]).optional(),
  auth: auth.optional(),
});

const httpRequest = z.object({
  info: z.object({
    type: z.literal('http'),
    name: z.string().min(1),
    description: description.optional(),
    seq: z.number().optional(),
    tags: z.array(z.string()).optional(),
  }),
  http: httpRequestDetails,
  runtime: z.object({}).passthrough().optional(),
  settings: z.object({}).passthrough().optional(),
  examples: z.array(z.unknown()).optional(),
  docs: z.string().optional(),
});

const grpcRequest = z.object({
  info: z.object({
    type: z.literal('grpc'),
    name: z.string().min(1),
    description: description.optional(),
    seq: z.number().optional(),
  }),
  grpc: z.object({
    url: z.string(),
    service: z.string(),
    method: z.string(),
    methodType: z.enum(['unary', 'serverStreaming', 'clientStreaming', 'bidirectional']).optional(),
    message: z.union([z.string(), z.array(z.unknown())]).optional(),
    // metadata mirrors httpHeader so `enabled`/`description` survive the
    // roundtrip (a bare {name,value} schema silently stripped them).
    metadata: z.array(httpHeader).optional(),
    auth: auth.optional(),
  }),
  // Canonical OC models GrpcRequestRuntime; without this field the parser
  // stripped gRPC pre-request/test scripts before the importer could read them.
  runtime: z.object({}).passthrough().optional(),
});

const graphqlRequest = z.object({
  info: z.object({
    type: z.literal('graphql'),
    name: z.string().min(1),
  }),
  graphql: z.object({
    url: z.string(),
    query: z.string().optional(),
    variables: z.string().optional(),
    headers: z.array(httpHeader).optional(),
    auth: auth.optional(),
  }),
});

const websocketRequest = z.object({
  info: z.object({
    type: z.literal('websocket'),
    name: z.string().min(1),
  }),
  websocket: z.object({
    url: z.string(),
    headers: z.array(httpHeader).optional(),
  }),
});

const folder: z.ZodType<unknown> = z.lazy(() =>
  z.object({
    info: z.object({
      name: z.string().min(1),
      description: description.optional(),
    }),
    items: z.array(item).optional(),
    request: z.unknown().optional(),
    docs: description.optional(),
  })
);

const item: z.ZodType<unknown> = z.lazy(() =>
  z.union([httpRequest, grpcRequest, graphqlRequest, websocketRequest, folder])
);

export const openCollectionSchema = z.object({
  opencollection: z.string(),
  info: info,
  config: z
    .object({
      environments: z.array(environment).optional(),
      protobuf: z.unknown().optional(),
      proxy: z.unknown().optional(),
      clientCertificates: z.array(z.unknown()).optional(),
    })
    .optional(),
  items: z.array(item).optional(),
  request: z.unknown().optional(),
  docs: description.optional(),
  bundled: z.boolean().optional(),
  extensions: z.record(z.string(), z.unknown()).optional(),
});

export type OpenCollection = z.infer<typeof openCollectionSchema>;

/**
 * Reject a maliciously deep/large parsed document *before* handing it to the
 * recursive (`z.lazy`) collection schema. Zod validates the tree recursively,
 * so a deeply-nested import (thousands of folders deep) would overflow the
 * stack inside `safeParse` itself — earlier than any field bound can fire.
 *
 * This is an iterative (non-recursive) walk over the already-JSON-parsed plain
 * object, so it can't itself overflow. Shape-agnostic: it counts every nested
 * object/array level, so it works for both OpenCollection (`items`/`folders`)
 * and other importers (e.g. Hoppscotch `folders`). Throws on violation.
 */
export function assertBoundedDocument(
  root: unknown,
  opts: { maxDepth?: number; maxNodes?: number } = {}
): void {
  const maxDepth = opts.maxDepth ?? 100;
  const maxNodes = opts.maxNodes ?? 1_000_000;
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    if (value === null || typeof value !== 'object') continue;
    if (depth > maxDepth) {
      throw new Error(`Document nesting exceeds the maximum depth of ${maxDepth}`);
    }
    if (++nodes > maxNodes) {
      throw new Error(`Document exceeds the maximum of ${maxNodes} nodes`);
    }
    const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
    for (const child of children) {
      if (child !== null && typeof child === 'object') {
        stack.push({ value: child, depth: depth + 1 });
      }
    }
  }
}
export const httpRequestSchema = httpRequest;
export const grpcRequestSchema = grpcRequest;
export const graphqlRequestSchema = graphqlRequest;
export const websocketRequestSchema = websocketRequest;
export const folderSchema = folder;
export const authSchema = auth;
export const environmentSchema = environment;
