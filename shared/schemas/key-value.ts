import { z } from 'zod';

// Key-Value Schema
export const keyValueSchema = z.object({
  id: z.string(),
  key: z.string(),
  value: z.string(),
  enabled: z.boolean(),
  description: z.string().optional(),
  // Mirrors KeyValue.secret: without it a parsed row loses its secret flag and
  // the value is treated as plain text. Plain optional so a row carrying an
  // explicit `secret: undefined` still validates (never quarantined); EOPT
  // consumers strip the undefined key after parsing.
  secret: z.boolean().optional(),
});
