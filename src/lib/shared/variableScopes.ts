/**
 * Single source of truth for merging the variable scopes a `{{var}}` reference
 * can resolve against. One set of inputs yields two derived outputs:
 *
 *  - `buildValueMap`  — the merged key→value map used for SUBSTITUTION at send time.
 *  - `buildKnownNames` — the set of names the VALIDATOR treats as "resolved".
 *
 * They are kept separate on purpose. Script-set keys (parsed statically from a
 * pre-request script) and `$dynamic` helpers legitimately resolve at runtime but
 * have no static value, so they belong in the known-names set only — putting them
 * in the value map would substitute empty/garbage. Conversely, only ENABLED
 * key-value entries count in either output, matching what the resolvers actually
 * substitute.
 *
 * Precedence (lowest → highest, later wins on key collision): globals < env <
 * collection < dataRow, with script mutations applied on top at the send site.
 * This mirrors Restura's existing collection-runner / CLI order (collection
 * overrides env); it is intentionally not strict Postman order.
 */
import type { KeyValue } from '@/types/common';

export interface ScopeInputs {
  /** Active-environment variables. */
  env?: KeyValue[] | undefined;
  /** Workspace-wide globals (`useGlobalsStore.vars`). */
  globals?: Record<string, string> | undefined;
  /** Variables from the collection the request belongs to. */
  collection?: KeyValue[] | undefined;
  /** Data-row variables (collection-runner iterations). */
  dataRow?: Record<string, string> | undefined;
  /** Literal keys statically parsed from a pre-request script (names only). */
  scriptSetKeys?: string[] | undefined;
}

function enabledEntries(vars: KeyValue[] | undefined): [string, string][] {
  if (!vars) return [];
  return vars.filter((v) => v.enabled && v.key).map((v) => [v.key, v.value]);
}

/**
 * Merged value map for substitution. Precedence: globals < env < collection <
 * dataRow. Script-set keys and dynamic helpers are NOT included (no static value).
 */
export function buildValueMap(inputs: ScopeInputs): Record<string, string> {
  const out: Record<string, string> = { ...(inputs.globals ?? {}) };
  for (const [k, v] of enabledEntries(inputs.env)) out[k] = v;
  for (const [k, v] of enabledEntries(inputs.collection)) out[k] = v;
  if (inputs.dataRow) Object.assign(out, inputs.dataRow);
  return out;
}

/**
 * Union of every name that can resolve: enabled env/collection keys, global keys,
 * data-row keys, and statically-parsed script-set keys. Values are irrelevant here.
 * (`$dynamic` helpers are handled separately by the validator.)
 */
export function buildKnownNames(inputs: ScopeInputs): Set<string> {
  const names = new Set<string>();
  for (const [k] of enabledEntries(inputs.env)) names.add(k);
  for (const [k] of enabledEntries(inputs.collection)) names.add(k);
  for (const k of Object.keys(inputs.globals ?? {})) names.add(k);
  for (const k of Object.keys(inputs.dataRow ?? {})) names.add(k);
  for (const k of inputs.scriptSetKeys ?? []) names.add(k);
  return names;
}
