/**
 * Socket.IO emit with `{{var}}` resolution (#974).
 *
 * The event name and the raw JSON args text are resolved through the shared
 * streaming resolver (same scopes as HTTP) *before* the args are parsed, so a
 * token can sit inside a JSON string. Unresolved tokens are warned about in
 * the event log; secret values are masked in the logged copy.
 */

import { socketioManager } from '@/features/socketio/lib/socketioManager';
import { useSocketIOStore } from '@/features/socketio/store/useSocketIOStore';
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
}

export function emitWithVariables(
  connectionId: string,
  input: EmitInput,
  scope: StreamingVariableScope = getActiveStreamingVariableScope()
): { ok: true } | { ok: false; error: string } {
  const name = resolveStreamingText(input.eventName.trim() || 'message', scope);
  const args = resolveStreamingText(input.args, scope);

  const parsed = parseEmitArgs(args.wire);
  if (!parsed.ok) return parsed;

  const unresolved = [...new Set([...name.unresolved, ...args.unresolved])];
  if (unresolved.length > 0) {
    useSocketIOStore.getState().addEvent(connectionId, {
      direction: 'system',
      eventName: '<system>',
      args: [formatUnresolvedWarning(unresolved)],
    });
  }

  let display: { eventName: string; args: unknown[] } | undefined;
  if (name.usedSecret || args.usedSecret) {
    const shown = parseEmitArgs(args.display);
    display = {
      eventName: name.display,
      // A masked secret outside a JSON string makes the display copy invalid
      // JSON — log a placeholder rather than the resolved args.
      args: shown.ok ? shown.args : ['[args hidden: contains secret values]'],
    };
  }

  socketioManager.emit(connectionId, name.wire, parsed.args, input.ack, display);
  return { ok: true };
}
