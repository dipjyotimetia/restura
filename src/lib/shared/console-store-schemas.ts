import { z } from 'zod';

/** Persisted shape for safe, non-executing console-native editor drafts. */
export const ConsoleNativeDraftSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('http'),
    credentialsOmitted: z.literal(true),
    url: z.string(),
    method: z.string(),
    headers: z.record(z.string(), z.string()),
    body: z.string().optional(),
  }),
  z.object({
    kind: z.literal('graphql'),
    credentialsOmitted: z.literal(true),
    url: z.string(),
    headers: z.record(z.string(), z.string()),
    query: z.string(),
    variables: z.string(),
    operationName: z.string().optional(),
  }),
  z.object({
    kind: z.literal('grpc'),
    credentialsOmitted: z.literal(true),
    url: z.string(),
    service: z.string(),
    method: z.string(),
    message: z.string(),
    metadata: z.record(z.string(), z.string()),
  }),
  z.object({
    kind: z.literal('mcp'),
    credentialsOmitted: z.literal(true),
    url: z.string(),
    transport: z.enum(['streamable-http', 'http-sse']),
    headers: z.record(z.string(), z.string()),
    method: z.string().optional(),
    params: z.string().optional(),
  }),
]);
