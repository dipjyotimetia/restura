import { readFile } from 'node:fs/promises';
import { load } from 'js-yaml';
import { z } from 'zod';
import {
  createSdkExternalSecretResolver,
  type ExternalSecretProfile,
} from './external-secret-providers.js';

const profileSchema = z.discriminatedUnion('provider', [
  z.object({
    id: z.string().min(1),
    provider: z.literal('aws-secrets-manager'),
    region: z.string().min(1),
    auth: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('named-profile'), profile: z.string().min(1) }),
      z.object({
        kind: z.literal('workload-identity'),
        roleArn: z.string().min(1),
        tokenFile: z.string().min(1),
        sessionName: z.string().min(1).optional(),
      }),
    ]),
  }),
  z.object({
    id: z.string().min(1),
    provider: z.literal('google-secret-manager'),
    projectId: z.string().min(1),
    auth: z.object({
      kind: z.enum(['named-profile', 'workload-identity']),
      credentialConfigFile: z.string().min(1),
    }),
  }),
  z.object({
    id: z.string().min(1),
    provider: z.literal('azure-key-vault'),
    vaultName: z.string().regex(/^[a-zA-Z0-9-]+$/),
    auth: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('named-profile'), subscription: z.string().min(1).optional() }),
      z.object({
        kind: z.literal('workload-identity'),
        tenantId: z.string().min(1),
        clientId: z.string().min(1),
        tokenFile: z.string().min(1),
      }),
    ]),
  }),
]);
const configSchema = z.object({ profiles: z.array(profileSchema).min(1) });

/** Load explicitly selected, credential-free profile metadata. */
export async function loadExternalSecretResolver(path: string | undefined) {
  if (!path) return undefined;
  const parsed = configSchema.parse(load(await readFile(path, 'utf8')));
  const ids = new Set<string>();
  for (const profile of parsed.profiles) {
    if (ids.has(profile.id))
      throw new Error(`External secret profile id is duplicated: ${profile.id}`);
    ids.add(profile.id);
  }
  return createSdkExternalSecretResolver(parsed.profiles as ExternalSecretProfile[]);
}
