/**
 * `{{var}}` resolution for outbound streaming messages (WebSocket frames,
 * Socket.IO emits, MQTT publishes — #927 / #974).
 *
 * Uses the same scope merge as the HTTP send path
 * (`buildActiveRequestVariableResolution`: globals < environment chain <
 * collection < folders) plus the built-in `{{$dynamic}}` helpers, and returns
 * two copies of the text:
 *
 *  - `wire`    — what goes over the socket (every resolvable token substituted).
 *  - `display` — what the transcript shows: identical, except values of
 *                variables marked secret are replaced with `SECRET_MASK`.
 *
 * Desktop secret *handles* never reach the renderer, so tokens that only
 * resolve to a handle stay literal and are reported as unresolved. Resolution
 * is single-pass over the original text — a substituted value is never itself
 * re-expanded — and nothing here writes back to any store.
 */

import { buildActiveRequestVariableResolution } from '@/lib/shared/activeRequestScopes';
import { applyDynamicVariables } from '@/lib/shared/dynamicVariables';
import { findVariableTokens } from '@/lib/shared/variableTokens';

export const SECRET_MASK = '••••••';

export interface StreamingVariableScope {
  values: Record<string, string>;
  /** Names whose value must never be shown in a transcript. */
  secretNames: ReadonlySet<string>;
  /** Names that resolve only to a desktop secret handle (no renderer value). */
  handleNames: ReadonlySet<string>;
}

export interface ResolvedStreamingText {
  wire: string;
  display: string;
  /** Distinct token names left literal, in order of first appearance. */
  unresolved: string[];
  /** True when at least one secret value was substituted into `wire`. */
  usedSecret: boolean;
}

/** Snapshot the variable scope that applies to the active tab right now. */
export function getActiveStreamingVariableScope(): StreamingVariableScope {
  const { values, secretVariables, secretNames } = buildActiveRequestVariableResolution();
  return {
    values,
    secretNames: new Set(secretNames ?? []),
    handleNames: new Set(Object.keys(secretVariables)),
  };
}

export function resolveStreamingText(
  text: string,
  scope: StreamingVariableScope
): ResolvedStreamingText {
  const tokens = findVariableTokens(text);
  if (tokens.length === 0) {
    return { wire: text, display: text, unresolved: [], usedSecret: false };
  }

  let wire = '';
  let display = '';
  let cursor = 0;
  let usedSecret = false;
  const unresolved: string[] = [];

  for (const token of tokens) {
    const raw = text.slice(token.start, token.end);
    const before = text.slice(cursor, token.start);
    wire += before;
    display += before;
    cursor = token.end;

    const { name } = token;
    if (name.startsWith('$')) {
      const generated = applyDynamicVariables(`{{${name}}}`);
      if (generated === `{{${name}}}`) {
        if (!unresolved.includes(name)) unresolved.push(name);
        wire += raw;
        display += raw;
      } else {
        wire += generated;
        display += generated;
      }
      continue;
    }

    if (Object.hasOwn(scope.values, name)) {
      const value = scope.values[name] as string;
      wire += value;
      if (scope.secretNames.has(name)) {
        usedSecret = true;
        display += SECRET_MASK;
      } else {
        display += value;
      }
      continue;
    }

    if (!unresolved.includes(name)) unresolved.push(name);
    wire += raw;
    display += raw;
  }

  const rest = text.slice(cursor);
  return { wire: wire + rest, display: display + rest, unresolved, usedSecret };
}

export function formatUnresolvedWarning(names: readonly string[]): string {
  return `Unresolved variables sent literally: ${names.map((n) => `{{${n}}}`).join(', ')}`;
}
