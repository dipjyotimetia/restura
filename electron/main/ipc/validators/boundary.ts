import { createLogger } from '@shared/runtime/logger';
import { z } from 'zod';

const log = createLogger('ipc');

// ===========================
// Store Schemas
// ===========================

// electron-store uses dot-notation for nested access (e.g. "a.b" reads obj.a.b).
// Dots and colons are allowed here intentionally — callers must use flat keys only
// to avoid unintended nesting side-effects.
export const StoreKeySchema = z
  .string()
  .min(1, 'Key is required')
  .max(256, 'Key too long')
  .regex(
    /^[a-zA-Z0-9._:-]+$/,
    'Key must contain only alphanumeric characters, dots, underscores, colons, or hyphens'
  );

export const StoreValueSchema = z.string().max(1024 * 1024, 'Value exceeds 1MB limit');

// store:set takes two args (key, value); createValidatedHandler validates 2+
// args as a tuple — same pattern as WriteFileSchema for fs:writeFile.
export const StoreSetSchema = z.tuple([StoreKeySchema, StoreValueSchema]);

// ===========================
// Log Schemas
// ===========================

export const LogHistoryLimitSchema = z.number().int().positive().max(1000).optional();

/** PNG data URL only; prevents the clipboard bridge accepting arbitrary file/HTML payloads. */
export const BugReportScreenshotSchema = z
  .string()
  .max(12 * 1024 * 1024, 'Screenshot exceeds 12MB')
  .regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/, 'Expected a PNG data URL');

// ===========================
// Validation Helper
// ===========================

/**
 * Returns true iff `url` is one of the renderer entry points the main
 * process trusts:
 *   - file:// → the packaged Electron app's dist/web/index.html
 *   - http://localhost:5173 or http://127.0.0.1:5173 → the Vite dev server
 *     used during `npm run electron:dev` (see window-manager.ts)
 *
 * Any other origin (including arbitrary localhost ports, https://, or
 * https://attacker.example) is rejected. Hash router segments live in the
 * URL fragment and don't affect this check.
 */
function isTrustedFrameUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    // Pin file:// to the packaged renderer entry (…/web/index.html) rather than
    // trusting ANY file: URL — so a stray/injected file frame can't masquerade
    // as the renderer. Hash-router state lives in the fragment, not the path.
    if (u.protocol === 'file:') return u.pathname.endsWith('/web/index.html');
    if (
      u.protocol === 'http:' &&
      (u.hostname === 'localhost' || u.hostname === '127.0.0.1') &&
      u.port === '5173'
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Defense-in-depth guard: rejects IPC traffic whose senderFrame is not the
 * legitimate renderer entry point. Protects against a compromised child
 * frame, redirected webContents, or a popup window calling into the main
 * process.
 */
export function assertTrustedSender(
  channel: string,
  event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent
): void {
  const frame = event.senderFrame;
  const url = frame?.url;
  // Only the trusted renderer's TOP frame may drive IPC. `parent` is null for
  // the main frame and a WebFrameMain for any child, so a subframe (e.g. an
  // injected <iframe>) is rejected even if it sits at a `/web/index.html` path —
  // the file:// URL suffix check is no longer the sole barrier.
  if (!isTrustedFrameUrl(url) || frame?.parent) {
    log.error('IPC frame rejected', { channel, senderFrame: url ?? '(undefined)' });
    throw new Error(`IPC ${channel} rejected: untrusted frame`);
  }
}

/**
 * Validates IPC input using a Zod schema
 * Throws a descriptive error if validation fails
 */
export function validateIpcInput<T>(schema: z.ZodSchema<T>, data: unknown, channel: string): T {
  try {
    return schema.parse(data);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessages = error.issues
        .map((err) => `${err.path.join('.')}: ${err.message}`)
        .join(', ');

      log.error('IPC validation error', {
        channel,
        issues: error.issues,
        // Never log the rejected payload. IPC inputs routinely contain auth
        // credentials, request bodies, TLS private keys, and file contents;
        // the Zod issue paths/types are sufficient to diagnose validation.
        receivedType: data === null ? 'null' : Array.isArray(data) ? 'array' : typeof data,
      });

      throw new Error(`Invalid IPC payload for ${channel}: ${errorMessages}`);
    }
    throw error;
  }
}

/**
 * Creates a validated IPC handler with automatic error handling.
 *
 * Argument unwrap:
 *   - 0 args (renderer invoked with no payload) → `undefined`
 *   - 1 arg                                     → `args[0]` (the typical case)
 *   - 2+ args                                   → the args array (validated as a tuple schema)
 *
 * The 0-args → undefined mapping is important: previously a zero-arg invoke
 * left `input = []` (empty array), which schemas like `z.object({})` reject
 * with "expected object, received array". `NoInputSchema` (`z.undefined()`)
 * is the right schema for those channels.
 */
export function createValidatedHandler<TInput, TOutput>(
  channel: string,
  schema: z.ZodSchema<TInput>,
  handler: (input: TInput) => Promise<TOutput> | TOutput
): (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => Promise<TOutput> {
  return createValidatedEventHandler(channel, schema, (input) => handler(input));
}

/** Validated invoke handler variant for ownership-sensitive channels. */
export function createValidatedEventHandler<TInput, TOutput>(
  channel: string,
  schema: z.ZodSchema<TInput>,
  handler: (input: TInput, event: Electron.IpcMainInvokeEvent) => Promise<TOutput> | TOutput
): (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => Promise<TOutput> {
  return async (event, ...args) => {
    assertTrustedSender(channel, event);
    const input = args.length === 0 ? undefined : args.length === 1 ? args[0] : args;
    const validated = validateIpcInput(schema, input, channel);
    return handler(validated as TInput, event);
  };
}

/**
 * Creates a validated IPC listener (for ipcMain.on) with automatic error handling
 */
export function createValidatedListener<TInput>(
  channel: string,
  schema: z.ZodSchema<TInput>,
  handler: (event: Electron.IpcMainEvent, input: TInput) => void
): (event: Electron.IpcMainEvent, ...args: unknown[]) => void {
  return (event, ...args) => {
    try {
      assertTrustedSender(channel, event);
      const input = args.length === 0 ? undefined : args.length === 1 ? args[0] : args;
      const validated = validateIpcInput(schema, input, channel);
      handler(event, validated as TInput);
    } catch (error) {
      log.error('IPC listener error', {
        channel,
        error: error instanceof Error ? error.message : String(error),
      });
      // For .on() handlers, we can't return errors, so we just log
    }
  };
}

/**
 * Schema for IPC channels that accept no input. Used together with
 * `createValidatedHandler` so the wrapper still calls `assertTrustedSender`
 * but the input validation accepts the zero-args case cleanly. Don't use
 * `z.object({}).strict().optional()` here — the wrapper now maps zero-args
 * to `undefined`, which `z.undefined()` accepts and `z.object({})` does not.
 */
export const NoInputSchema = z.undefined();
