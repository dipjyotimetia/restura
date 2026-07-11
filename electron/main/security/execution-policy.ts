import { ipcMain } from 'electron';
import { z } from 'zod';
import { protocolSecretValueSchema } from '@shared/protocol/secret-value-schema';
import { IPC } from '../../shared/channels';
import { createValidatedHandler } from '../ipc/ipc-validators';

const ClientCertSchema = z
  .object({
    format: z.enum(['pfx', 'pem']),
    pfx: z.string().min(1).optional(),
    cert: z.string().min(1).optional(),
    key: z.string().min(1).optional(),
    passphrase: protocolSecretValueSchema.optional(),
  })
  .superRefine((cert, ctx) => {
    const hasPfx = cert.pfx !== undefined;
    const hasPemPair = cert.cert !== undefined && cert.key !== undefined;
    if ((cert.format === 'pfx' && !hasPfx) || (cert.format === 'pem' && !hasPemPair)) {
      ctx.addIssue({ code: 'custom', message: 'Certificate material does not match its format' });
    }
  });

const CaCertSchema = z.object({ pem: z.string().min(1) });

const ProxySchema = z.object({
  enabled: z.boolean(),
  type: z.enum(['none', 'http', 'https', 'socks4', 'socks5']),
  host: z.string(),
  port: z.number().int().min(1).max(65535),
  bypassList: z.array(z.string()),
  auth: z.object({ username: z.string(), password: protocolSecretValueSchema }).optional(),
});

const HostClientCertSchema = z.object({
  id: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).optional(),
  cert: ClientCertSchema,
});

const HostCaCertSchema = z.object({
  id: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).optional(),
  pem: z.string().min(1),
});

/** The complete renderer-authored policy that will govern desktop execution. */
export const ExecutionPolicySchema = z.object({
  security: z.object({ allowLocalhost: z.boolean(), allowPrivateIPs: z.boolean() }),
  proxy: ProxySchema,
  timeout: z.number().int().positive(),
  tls: z.object({
    verifySsl: z.boolean(),
    serverCipherOrder: z.boolean(),
    minTlsVersion: z.enum(['TLSv1', 'TLSv1.1', 'TLSv1.2', 'TLSv1.3']).optional(),
    cipherSuites: z.string().min(1).optional(),
  }),
  certificates: z.object({
    clientCert: ClientCertSchema.optional(),
    caCert: CaCertSchema.optional(),
    clientCertificates: z.array(HostClientCertSchema),
    caCertificates: z.array(HostCaCertSchema),
  }),
});

export type ExecutionPolicy = z.infer<typeof ExecutionPolicySchema>;

const safeDefaultPolicy: ExecutionPolicy = {
  security: { allowLocalhost: true, allowPrivateIPs: false },
  proxy: { enabled: false, type: 'http', host: '', port: 8080, bypassList: [] },
  timeout: 30_000,
  tls: { verifySsl: true, serverCipherOrder: false },
  certificates: { clientCertificates: [], caCertificates: [] },
};

let policy: ExecutionPolicy = safeDefaultPolicy;
let acknowledged = false;

/**
 * Returns a parsed copy so callers cannot mutate the main-process snapshot.
 * Adapters will consume this after they opt into execution-policy enforcement.
 */
export function getExecutionPolicy(): ExecutionPolicy {
  return ExecutionPolicySchema.parse(policy);
}

/** True only once main has accepted a renderer-provided, validated snapshot. */
export function isExecutionPolicyReady(): boolean {
  return acknowledged;
}

/**
 * Enforcement hook for outbound adapters. It deliberately fails closed before
 * the renderer's hydrated settings have been accepted by the main process.
 */
export function assertExecutionPolicyReady(): void {
  if (!acknowledged) {
    throw new Error('Execution policy has not been acknowledged by the renderer');
  }
}

/** Parse before replacing the policy so rejected IPC can never partially update it. */
export function setExecutionPolicy(next: unknown): ExecutionPolicy {
  policy = ExecutionPolicySchema.parse(next);
  acknowledged = true;
  return getExecutionPolicy();
}

export function registerExecutionPolicyIPC(): void {
  ipcMain.handle(
    IPC.security.setExecutionPolicy,
    createValidatedHandler(
      IPC.security.setExecutionPolicy,
      ExecutionPolicySchema,
      (next): { ok: true } => {
        setExecutionPolicy(next);
        return { ok: true };
      }
    )
  );
}
