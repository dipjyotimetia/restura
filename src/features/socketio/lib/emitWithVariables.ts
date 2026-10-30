/**
 * Socket.IO emit with `{{var}}` resolution (#974).
 *
 * The event name and the raw JSON args text are resolved through the shared
 * streaming resolver (same scopes as HTTP) *before* the args are parsed, so a
 * token can sit inside a JSON string. Unresolved tokens are warned about in
 * the event log; secret values are masked in the logged copy.
 */

import { decodeBinaryArgs, encodeBinaryArgs } from '@shared/socketio-payload';
import { socketioManager } from '@/features/socketio/lib/socketioManager';
import {
  type SocketIOEmitOptions,
  useSocketIOStore,
} from '@/features/socketio/store/useSocketIOStore';
import {
  formatUnresolvedWarning,
  getActiveStreamingVariableScope,
  resolveStreamingText,
  type StreamingVariableScope,
} from '@/lib/shared/streaming/messageVariables';

export type ParsedEmitArgs = { ok: true; args: unknown[] } | { ok: false; error: string };

/** Parse composer text: empty → no args, a JSON array → spread, any other value → one arg. */
export function parseEmitArgs(input: string): ParsedEmitArgs {
  const trimmed = input.trim();
  if (!trimmed) return { ok: true, args: [] };
  try {
    const parsed = JSON.parse(trimmed);
    return { ok: true, args: Array.isArray(parsed) ? parsed : [parsed] };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Invalid JSON' };
  }
}

export interface EmitInput {
  eventName: string;
  args: string;
  ack: boolean;
  /** Per-emit modifiers: volatile, compress, ack timeout (SIO-5). */
  options?: Partial<SocketIOEmitOptions>;
}

type ResolvedArgs =
  | {
      ok: true;
      /** Wire args — `{ $binary }` markers decoded to `Uint8Array`. */
      args: unknown[];
      /** Masked copy for the log, set only when a secret was substituted. */
      displayArgs?: unknown[];
      unresolved: string[];
      usedSecret: boolean;
    }
  | { ok: false; error: string };

/** Resolve `{{var}}` in composer JSON text, parse it and decode binary markers. */
function resolveArgsText(text: string, scope: StreamingVariableScope): ResolvedArgs {
  // JSON-aware: a value inside a string literal is escaped, never injected as structure.
  const args = resolveStreamingText(text, scope, { json: true });
  const parsed = parseEmitArgs(args.wire);
  if (!parsed.ok) {
    // V8 quotes the offending input in JSON.parse errors, so a parse error on
    // the resolved text can leak a secret. Report the masked copy's error, or
    // a generic one when only the secret value broke the JSON.
    if (!args.usedSecret) return parsed;
    const shown = parseEmitArgs(args.display);
    return { ok: false, error: shown.ok ? 'Invalid JSON' : shown.error };
  }
  let wire: unknown[];
  try {
    wire = decodeBinaryArgs(parsed.args);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Invalid binary argument' };
  }
  let displayArgs: unknown[] | undefined;
  if (args.usedSecret) {
    const shown = parseEmitArgs(args.display);
    // A masked secret outside a JSON string makes the display copy invalid
    // JSON — log a placeholder rather than the resolved args.
    displayArgs = shown.ok ? shown.args : ['[args hidden: contains secret values]'];
  }
  return {
    ok: true,
    args: wire,
    ...(displayArgs ? { displayArgs } : {}),
    unresolved: args.unresolved,
    usedSecret: args.usedSecret,
  };
}

function warnUnresolved(connectionId: string, unresolved: string[]): void {
  const unique = [...new Set(unresolved)];
  if (unique.length === 0) return;
  useSocketIOStore.getState().addEvent(connectionId, {
    direction: 'system',
    eventName: '<system>',
    args: [formatUnresolvedWarning(unique)],
  });
}

export function emitWithVariables(
  connectionId: string,
  input: EmitInput,
  scope: StreamingVariableScope = getActiveStreamingVariableScope()
): { ok: true } | { ok: false; error: string } {
  const name = resolveStreamingText(input.eventName.trim() || 'message', scope);
  const args = resolveArgsText(input.args, scope);
  if (!args.ok) return args;

  warnUnresolved(connectionId, [...name.unresolved, ...args.unresolved]);

  let display: { eventName: string; args: unknown[] } | undefined;
  if (name.usedSecret || args.usedSecret) {
    display = {
      eventName: name.display,
      args: args.displayArgs ?? encodeBinaryArgs(args.args),
    };
  }

  socketioManager.emit(connectionId, name.wire, args.args, input.ack, display, input.options ?? {});
  return { ok: true };
}

/**
 * Answer a server-requested acknowledgement (SIO-1) with composer-style JSON
 * args — same `{{var}}` resolution, binary markers and secret masking as emits.
 */
export function replyAckWithVariables(
  connectionId: string,
  serverAckId: string,
  argsText: string,
  scope: StreamingVariableScope = getActiveStreamingVariableScope()
): { ok: true } | { ok: false; error: string } {
  const args = resolveArgsText(argsText, scope);
  if (!args.ok) return args;
  warnUnresolved(connectionId, args.unresolved);
  socketioManager.replyServerAck(
    connectionId,
    serverAckId,
    args.args,
    args.displayArgs ? { args: args.displayArgs } : undefined
  );
  return { ok: true };
}
