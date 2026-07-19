import { z } from 'zod';
import { isCloudMetadataHost, isPrivateAddress } from '@shared/protocol/url-validation';

const EnvironmentSchema = z.string().trim().min(1).max(100);
const SampleRateSchema = z.number().min(0).max(1);

export const TelemetryCredentialRefSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('secret-handle'), id: z.uuid() }).strict(),
  z.object({ source: z.literal('env'), name: z.string().regex(/^[A-Z][A-Z0-9_]*$/) }).strict(),
]);

function validateEndpoint(value: string, context: z.RefinementCtx): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    context.addIssue({ code: 'custom', message: 'Telemetry endpoint must be an absolute URL' });
    return;
  }
  const loopback =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    context.addIssue({
      code: 'custom',
      message: 'Telemetry endpoints must use HTTPS, except HTTP loopback collectors',
    });
  }
  if (!loopback && (isCloudMetadataHost(url.hostname) || isPrivateAddress(url.hostname))) {
    context.addIssue({
      code: 'custom',
      message: 'Telemetry endpoint must not target a private or metadata address',
    });
  }
  if (url.username || url.password || url.search || url.hash) {
    context.addIssue({
      code: 'custom',
      message: 'Telemetry endpoint must not include credentials, query parameters, or fragments',
    });
  }
}

export const TelemetryEndpointSchema = z.string().url().superRefine(validateEndpoint);

export const AgentTelemetryConfigSchema = z.discriminatedUnion('target', [
  z
    .object({
      enabled: z.boolean().default(false),
      target: z.literal('langfuse'),
      baseUrl: TelemetryEndpointSchema,
      publicKey: TelemetryCredentialRefSchema,
      secretKey: TelemetryCredentialRefSchema,
      environment: EnvironmentSchema,
      sampleRate: SampleRateSchema,
    })
    .strict(),
  z
    .object({
      enabled: z.boolean().default(false),
      target: z.literal('otlp'),
      endpoint: TelemetryEndpointSchema,
      environment: EnvironmentSchema,
      sampleRate: SampleRateSchema,
      auth: z.discriminatedUnion('mode', [
        z.object({ mode: z.literal('none') }).strict(),
        z.object({ mode: z.literal('bearer'), token: TelemetryCredentialRefSchema }).strict(),
      ]),
    })
    .strict(),
]);

export type AgentTelemetryConfig = z.infer<typeof AgentTelemetryConfigSchema>;
export type TelemetryCredentialRef = z.infer<typeof TelemetryCredentialRefSchema>;
