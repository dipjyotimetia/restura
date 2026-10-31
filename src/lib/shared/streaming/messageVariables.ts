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

export interface ResolveStreamingOptions {
  /**
   * Treat the text as JSON: a token inside a string literal gets a
   * JSON-escaped value, so a value containing `"` or `\` stays one string
   * instead of injecting structure. Tokens outside strings substitute raw
   * (unquoted numbers / objects keep working).
   */
  json?: boolean;
}

/** Advance the "inside a JSON string literal" state across `segment`. */
function scanJsonString(segment: string, state: { inString: boolean; escaped: boolean }): void {
  for (const ch of segment) {
    if (state.escaped) state.escaped = false;
    else if (ch === '\\' && state.inString) state.escaped = true;
    else if (ch === '"') state.inString = !state.inString;
  }
}

export function resolveStreamingText(
  text: string,
  scope: StreamingVariableScope,
  options: ResolveStreamingOptions = {}
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
  const json = { inString: false, escaped: false };
  // A substituted value is encoded for its context, so it leaves the string
  // state alone. A token left literal stays on the wire, and the grammar lets it
  // hold quotes (`{{a"b}}`), so its text advances the state like any other.
  const keepLiteral = (raw: string) => {
    wire += raw;
    display += raw;
    if (options.json) scanJsonString(raw, json);
  };
  const encode = (value: string) =>
    options.json && json.inString ? JSON.stringify(value).slice(1, -1) : value;

  for (const token of tokens) {
    const raw = text.slice(token.start, token.end);
    const before = text.slice(cursor, token.start);
    wire += before;
    display += before;
    cursor = token.end;
    if (options.json) scanJsonString(before, json);

    const { name } = token;
    if (name.startsWith('$')) {
      const generated = applyDynamicVariables(`{{${name}}}`);
      if (generated === `{{${name}}}`) {
        if (!unresolved.includes(name)) unresolved.push(name);
        keepLiteral(raw);
      } else {
        wire += encode(generated);
        display += encode(generated);
      }
      continue;
    }

    if (Object.hasOwn(scope.values, name)) {
      const value = scope.values[name] as string;
      wire += encode(value);
      if (scope.secretNames.has(name)) {
        usedSecret = true;
        display += SECRET_MASK;
      } else {
        display += encode(value);
      }
      continue;
    }

    if (!unresolved.includes(name)) unresolved.push(name);
    keepLiteral(raw);
  }

  const rest = text.slice(cursor);
  return { wire: wire + rest, display: display + rest, unresolved, usedSecret };
}

export function formatUnresolvedWarning(names: readonly string[]): string {
  return `Unresolved variables sent literally: ${names.map((n) => `{{${n}}}`).join(', ')}`;
}
