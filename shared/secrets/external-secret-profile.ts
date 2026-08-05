import { z } from 'zod';

/**
 * Non-secret provider configuration for an external secret reference.
 *
 * These records intentionally contain identity *locations* only (AWS profile,
 * workload token file, Azure CLI subscription, etc.). Actual credentials stay
 * with the provider SDK's documented credential source and are never stored in
 * a collection or returned by Electron IPC.
 */
export const externalSecretProviderSchema = z.enum([
  'aws-secrets-manager',
  'google-secret-manager',
  'azure-key-vault',
]);

const profileIdSchema = z.string().min(1).max(128);
const profileLabelSchema = z.string().trim().min(1).max(128).optional();
const filePathSchema = z.string().trim().min(1).max(4096);

const awsProfileSchema = z
  .object({
    id: profileIdSchema,
    label: profileLabelSchema,
    provider: z.literal('aws-secrets-manager'),
    region: z.string().trim().min(1).max(64),
    auth: z.union([
      z.object({ kind: z.literal('named-profile'), profile: z.string().trim().min(1).max(256) }),
      z.object({
        kind: z.literal('workload-identity'),
        roleArn: z.string().trim().min(1).max(2048),
        tokenFile: filePathSchema,
        sessionName: z.string().trim().min(1).max(64).optional(),
      }),
    ]),
  })
  .strict();

const googleProfileSchema = z
  .object({
    id: profileIdSchema,
    label: profileLabelSchema,
    provider: z.literal('google-secret-manager'),
    projectId: z.string().trim().min(1).max(256),
    auth: z.object({
      kind: z.enum(['named-profile', 'workload-identity']),
      credentialConfigFile: filePathSchema,
    }),
  })
  .strict();

const azureProfileSchema = z
  .object({
    id: profileIdSchema,
    label: profileLabelSchema,
    provider: z.literal('azure-key-vault'),
    vaultName: z
      .string()
      .trim()
      .regex(/^[a-zA-Z0-9-]{3,24}$/),
    auth: z.union([
      z.object({
        kind: z.literal('named-profile'),
        subscription: z.string().trim().min(1).max(256).optional(),
      }),
      z.object({
        kind: z.literal('workload-identity'),
        tenantId: z.string().trim().min(1).max(256),
        clientId: z.string().trim().min(1).max(256),
        tokenFile: filePathSchema,
      }),
    ]),
  })
  .strict();

export const externalSecretProfileSchema = z.discriminatedUnion('provider', [
  awsProfileSchema,
  googleProfileSchema,
  azureProfileSchema,
]);

export type ExternalSecretProfile = z.infer<typeof externalSecretProfileSchema>;

export const externalSecretProfileInputSchema = z.discriminatedUnion('provider', [
  awsProfileSchema.omit({ id: true }),
  googleProfileSchema.omit({ id: true }),
  azureProfileSchema.omit({ id: true }),
]);

export type ExternalSecretProfileInput = z.infer<typeof externalSecretProfileInputSchema>;

export const externalSecretProfileListSchema = z.array(externalSecretProfileSchema).max(100);
