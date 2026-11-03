import { z } from 'zod';

// Key-Value Schema
export const keyValueSchema = z.object({
  id: z.string(),
  key: z.string(),
  value: z.string(),
  enabled: z.boolean(),
  description: z.string().optional(),
  // Mirrors KeyValue.secret: without it a parsed row loses its secret flag and
  // the value is treated as plain text. Exact-optional to match `secret?:
  // boolean` under exactOptionalPropertyTypes; producers omit the key rather
  // than writing `undefined`.
  secret: z.boolean().exactOptional(),
});
