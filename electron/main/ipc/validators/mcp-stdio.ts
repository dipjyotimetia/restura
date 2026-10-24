import * as path from 'node:path';
import { isSecretFieldName } from '@shared/secrets/key-value-redaction';
import { z } from 'zod';
import {
  hasControlChars,
  hasControlCharsInValue,
  isExecutionSensitiveEnvName,
  isUncOrDevicePath,
  MCP_STDIO_LIMITS as L,
} from '../../security/mcp-stdio-policy';
import { McpConnectionIdSchema } from './core';

// ===========================
// MCP stdio transport (#854, ADR 0030) — desktop only
// ===========================

/** Unicode Cc/Cf/Zl/Zp (controls, bidi/zero-width format chars, separators). */
const noControlChars = (value: string) => !hasControlChars(value);
const notUncOnWindows = (value: string) =>
  process.platform !== 'win32' || !isUncOrDevicePath(value);

const StdioCommandSchema = z
  .string()
  .min(1, 'Command is required')
  .max(L.commandMaxLength)
  .refine((v) => v.trim() === v, { message: 'Command must not have leading/trailing whitespace' })
  .refine(noControlChars, {
    message: 'Command must not contain control, format or line-separator characters',
  })
  .refine(notUncOnWindows, { message: 'Network (UNC) and device paths are not allowed' });

const StdioArgSchema = z.string().max(L.argMaxLength).refine(noControlChars, {
  message: 'Arguments must not contain control, format or line-separator characters',
});

const StdioCwdSchema = z
  .string()
  .min(1)
  .max(L.cwdMaxLength)
  .refine(noControlChars, {
    message: 'Working directory must not contain control, format or line-separator characters',
  })
  .refine((v) => path.isAbsolute(v), { message: 'Working directory must be an absolute path' })
  .refine(notUncOnWindows, { message: 'Network (UNC) and device paths are not allowed' });

const EnvNameSchema = z
  .string()
  .max(L.envNameMaxLength)
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*$/,
    'Environment variable names must match [A-Za-z_][A-Za-z0-9_]*'
  );

const EnvPlainValueSchema = z
  .string()
  .max(L.envValueMaxLength)
  // Plain values are shown in the consent dialog, so the same spoofing rule applies.
  .refine((v) => !hasControlCharsInValue(v), {
    message:
      'Environment values must not contain control, format or separator characters (TAB and line breaks are allowed)',
  });

/**
 * A value is plaintext, an inline SecretRef, or a secret-store handle that
 * main resolves at spawn time (ADR-0007). `external` vault refs are not
 * supported for stdio env (they would need an async provider round-trip in
 * the spawn path).
 */
const EnvValueSchema = z.union([
  EnvPlainValueSchema,
  z.object({ kind: z.literal('inline'), value: EnvPlainValueSchema }).strict(),
  z
    .object({
      kind: z.literal('handle'),
      id: z.string().min(1).max(128),
      // Ignored for display: main shows the label stored with the handle.
      label: z.string().max(256).refine(noControlChars).optional(),
    })
    .strict(),
]);

export type McpStdioEnvValue = z.infer<typeof EnvValueSchema>;

/**
 * `mcp:connect` payload for `transport: 'stdio'`. `.strict()` everywhere: a
 * renderer (or an imported collection travelling through it) cannot smuggle
 * a consent/approval flag — consent is decided only by main's own store and
 * native dialog (see security/mcp-stdio-consent.ts).
 */
export const McpStdioConnectSchema = z
  .object({
    connectionId: McpConnectionIdSchema,
    transport: z.literal('stdio'),
    command: StdioCommandSchema,
    args: z.array(StdioArgSchema).max(L.argsMaxCount).default([]),
    cwd: StdioCwdSchema.optional(),
    env: z
      .record(EnvNameSchema, EnvValueSchema)
      .refine((env) => Object.keys(env).length <= L.envMaxEntries, {
        message: `Too many environment variables (max ${L.envMaxEntries})`,
      })
      .optional(),
  })
  .strict()
  .refine((cfg) => cfg.args.reduce((sum, arg) => sum + arg.length, 0) <= L.argsTotalMaxLength, {
    message: `Arguments exceed ${L.argsTotalMaxLength} characters in total`,
    path: ['args'],
  })
  .refine(
    (cfg) =>
      Object.entries(cfg.env ?? {}).every(
        ([name, value]) =>
          typeof value === 'string' ||
          value.kind === 'inline' ||
          (isSecretFieldName(name) && !isExecutionSensitiveEnvName(name))
      ),
    {
      message:
        'Only credential-named, non-execution-sensitive environment variables may come from the secret store; others must be plain values so the consent prompt can show them',
      path: ['env'],
    }
  );

export type McpStdioConnectConfig = z.infer<typeof McpStdioConnectSchema>;

/** True when a raw `mcp:connect` payload asks for the stdio transport. */
export function isStdioConnectPayload(raw: unknown): boolean {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    (raw as { transport?: unknown }).transport === 'stdio'
  );
}
