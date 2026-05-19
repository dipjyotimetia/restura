import { z } from 'zod';
import type { ProtocolSecretValue } from './types';

/**
 * Canonical Zod schema for `ProtocolSecretValue` (and the renderer's
 * structurally identical `SecretValue`). Lives in `shared/protocol/` so the
 * Worker, Electron main IPC validators, and the renderer can all import it
 * — there was a pre-cleanup state where the same union was declared in three
 * places and drift was already starting.
 *
 * Type annotation is intentionally absent — Zod's inferred output uses
 * `label?: string | undefined`, while `ProtocolSecretRef` uses `label?: string`.
 * Under `exactOptionalPropertyTypes: true` those are distinct, so we let
 * inference speak and consumers cast at the boundary if needed.
 */
export const protocolSecretValueSchema = z.union([
  z.string(),
  z.object({ kind: z.literal('inline'), value: z.string() }),
  z.object({ kind: z.literal('handle'), id: z.string(), label: z.string().optional() }),
]);

/** True iff the value is a handle reference — the only form Worker cannot resolve. */
export function isProtocolSecretHandle(
  value: ProtocolSecretValue | unknown
): value is { kind: 'handle'; id: string; label?: string } {
  return !!value && typeof value === 'object' && (value as { kind?: unknown }).kind === 'handle';
}
