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
 * Precedence (lowest → highest, later wins on key collision): globals < base
 * environment < selected sub-environment < collection < ancestor folders <
 * data row, with script mutations applied on top at the send site.
 * This mirrors Restura's existing collection-runner / CLI order (collection
 * overrides env); it is intentionally not strict Postman order.
 */
import type { KeyValue } from '@/types/common';

export interface ScopeInputs {
  /** Active-environment variables. */
  env?: KeyValue[] | undefined;
  /** Root environment variables. `env` remains for flat persisted data. */
  baseEnvironment?: KeyValue[] | undefined;
  /** Variables from the selected child environment. */
  subEnvironment?: KeyValue[] | undefined;
  /** Workspace-wide globals (`useGlobalsStore.vars`). */
  globals?: Record<string, string> | undefined;
  /** Variables from the collection the request belongs to. */
  collection?: KeyValue[] | undefined;
  /** Folder variables from outermost ancestor to the request's direct parent. */
  folders?: ReadonlyArray<KeyValue[] | undefined> | undefined;
  /** Data-row variables (collection-runner iterations). */
  dataRow?: Record<string, string> | undefined;
  /** Literal keys statically parsed from a pre-request script (names only). */
  scriptSetKeys?: string[] | undefined;
}

export type VariableProvenance =
  | 'global'
  | 'base-environment'
  | 'sub-environment'
  | 'collection'
  | 'folder'
  | 'data-row';

export interface ScopedVariableResolution {
  values: Record<string, string>;
  provenance: Record<string, VariableProvenance>;
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
  return buildScopedVariableResolution(inputs).values;
}

/**
 * Resolve values and their winning source together. Consumers can use the
 * values for substitution and the provenance map for inspector/autocomplete
 * UI without attempting to reconstruct precedence independently.
 */
export function buildScopedVariableResolution(inputs: ScopeInputs): ScopedVariableResolution {
  const values: Record<string, string> = {};
  const provenance: Record<string, VariableProvenance> = {};
  const assign = (entries: Iterable<[string, string]>, source: VariableProvenance) => {
    for (const [key, value] of entries) {
      values[key] = value;
      provenance[key] = source;
    }
  };

  assign(Object.entries(inputs.globals ?? {}), 'global');
  // `env` is the backward-compatible flat environment input. A hierarchical
  // caller supplies baseEnvironment and (optionally) subEnvironment instead.
  assign(enabledEntries(inputs.baseEnvironment ?? inputs.env), 'base-environment');
  assign(enabledEntries(inputs.subEnvironment), 'sub-environment');
  assign(enabledEntries(inputs.collection), 'collection');
  for (const folder of inputs.folders ?? []) assign(enabledEntries(folder), 'folder');
  assign(Object.entries(inputs.dataRow ?? {}), 'data-row');
  return { values, provenance };
}

/**
 * Union of every name that can resolve: enabled env/collection keys, global keys,
 * data-row keys, and statically-parsed script-set keys. Values are irrelevant here.
 * (`$dynamic` helpers are handled separately by the validator.)
 */
export function buildKnownNames(inputs: ScopeInputs): Set<string> {
  const names = new Set<string>();
  for (const [k] of enabledEntries(inputs.baseEnvironment ?? inputs.env)) names.add(k);
  for (const [k] of enabledEntries(inputs.subEnvironment)) names.add(k);
  for (const [k] of enabledEntries(inputs.collection)) names.add(k);
  for (const folder of inputs.folders ?? []) {
    for (const [k] of enabledEntries(folder)) names.add(k);
  }
  for (const k of Object.keys(inputs.globals ?? {})) names.add(k);
  for (const k of Object.keys(inputs.dataRow ?? {})) names.add(k);
  for (const k of inputs.scriptSetKeys ?? []) names.add(k);
  return names;
}
