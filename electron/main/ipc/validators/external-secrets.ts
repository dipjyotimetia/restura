import {
  externalSecretProfileInputSchema,
  externalSecretProfileSchema,
} from '@shared/secrets/external-secret-profile';
import { z } from 'zod';

/** Renderer input for creation; main assigns the opaque profile id. */
export const ExternalSecretProfileCreateSchema = externalSecretProfileInputSchema;
export const ExternalSecretProfileUpdateSchema = externalSecretProfileSchema;
export const ExternalSecretProfileDeleteSchema = z
  .object({ id: z.string().min(1).max(128) })
  .strict();
