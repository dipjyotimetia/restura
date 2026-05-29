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
// Length caps: 64 KB comfortably covers the largest real secrets (PEM keys,
// long JWTs) while bounding memory; handle ids are UUIDs (~36 chars) so 128 is
// generous. These bound every auth descriptor that carries a secret, since all
// of them consume this single schema.
const SECRET_MAX_LEN = 64 * 1024;

export const protocolSecretValueSchema = z.union([
  z.string().max(SECRET_MAX_LEN),
  z.object({ kind: z.literal('inline'), value: z.string().max(SECRET_MAX_LEN) }),
  z.object({
    kind: z.literal('handle'),
    id: z.string().max(128),
    label: z.string().max(256).optional(),
  }),
]);

/** True iff the value is a handle reference — the only form Worker cannot resolve. */
export function isProtocolSecretHandle(
  value: ProtocolSecretValue | unknown
): value is { kind: 'handle'; id: string; label?: string } {
  return !!value && typeof value === 'object' && (value as { kind?: unknown }).kind === 'handle';
}
