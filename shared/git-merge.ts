export type StructuredChoice = 'base' | 'local' | 'incoming' | 'delete';

export type StructuredMergeValue =
  | { present: false }
  | {
      present: true;
      value: unknown;
    };

export interface StructuredConflict {
  path: string;
  base: StructuredMergeValue;
  local: StructuredMergeValue;
  incoming: StructuredMergeValue;
}

export interface StructuredMerge {
  /** Provisional result. Conflicting paths default to the local value. */
  result: unknown;
  conflicts: StructuredConflict[];
}

const MISSING: StructuredMergeValue = Object.freeze({ present: false });

export function createStructuredMerge(
  base: unknown,
  local: unknown,
  incoming: unknown
): StructuredMerge {
  const conflicts: StructuredConflict[] = [];
  const merged = mergeValue(
    toMergeValue(base),
    toMergeValue(local),
    toMergeValue(incoming),
    '',
    conflicts
  );
  return {
    result: merged.present ? cloneValue(merged.value) : undefined,
    conflicts,
  };
}

export function applyStructuredChoices(
  merge: StructuredMerge,
  choices: Readonly<Record<string, StructuredChoice>>
): unknown {
  const conflictPaths = new Set(merge.conflicts.map((conflict) => conflict.path));
  for (const path of Object.keys(choices)) {
    if (!conflictPaths.has(path)) {
      throw new Error(`Unknown conflict path: ${path}`);
    }
  }

  let result = cloneValue(merge.result);
  for (const conflict of merge.conflicts) {
    const choice = choices[conflict.path];
    if (!choice) throw new Error(`A choice is required for conflict ${conflict.path}`);
    const selected =
      choice === 'delete'
        ? MISSING
        : choice === 'base'
          ? conflict.base
          : choice === 'local'
            ? conflict.local
            : conflict.incoming;
    result = setPointerValue(result, conflict.path, selected);
  }
  return result;
}

function mergeValue(
  base: StructuredMergeValue,
  local: StructuredMergeValue,
  incoming: StructuredMergeValue,
  path: string,
  conflicts: StructuredConflict[]
): StructuredMergeValue {
  if (mergeValuesEqual(local, incoming)) return cloneMergeValue(local);
  if (mergeValuesEqual(base, local)) return cloneMergeValue(incoming);
  if (mergeValuesEqual(base, incoming)) return cloneMergeValue(local);

  if (
    base.present &&
    local.present &&
    incoming.present &&
    isPlainRecord(base.value) &&
    isPlainRecord(local.value) &&
    isPlainRecord(incoming.value)
  ) {
    return {
      present: true,
      value: mergeRecords(base.value, local.value, incoming.value, path, conflicts),
    };
  }

  conflicts.push({
    path: path || '',
    base: cloneMergeValue(base),
    local: cloneMergeValue(local),
    incoming: cloneMergeValue(incoming),
  });
  return cloneMergeValue(local);
}

function mergeRecords(
  base: Record<string, unknown>,
  local: Record<string, unknown>,
  incoming: Record<string, unknown>,
  parentPath: string,
  conflicts: StructuredConflict[]
): Record<string, unknown> {
  const keys = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(incoming)]);
  const entries: Array<[string, unknown]> = [];
  for (const key of keys) {
    const merged = mergeValue(
      propertyValue(base, key),
      propertyValue(local, key),
      propertyValue(incoming, key),
      `${parentPath}/${escapePointerSegment(key)}`,
      conflicts
    );
    if (merged.present) entries.push([key, cloneValue(merged.value)]);
  }
  return Object.fromEntries(entries);
}

function propertyValue(record: Record<string, unknown>, key: string): StructuredMergeValue {
  return Object.hasOwn(record, key) ? { present: true, value: record[key] } : MISSING;
}

function toMergeValue(value: unknown): StructuredMergeValue {
  return { present: true, value };
}

function cloneMergeValue(value: StructuredMergeValue): StructuredMergeValue {
  return value.present ? { present: true, value: cloneValue(value.value) } : MISSING;
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function mergeValuesEqual(left: StructuredMergeValue, right: StructuredMergeValue): boolean {
  if (left.present !== right.present) return false;
  return !left.present || !right.present || valuesEqual(left.value, right.value);
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => valuesEqual(value, right[index]));
  }
  if (!isPlainRecord(left) || !isPlainRecord(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => Object.hasOwn(right, key) && valuesEqual(left[key], right[key]))
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function escapePointerSegment(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function unescapePointerSegment(value: string): string {
  return value.replaceAll('~1', '/').replaceAll('~0', '~');
}

function setPointerValue(root: unknown, pointer: string, selected: StructuredMergeValue): unknown {
  if (pointer === '') return selected.present ? cloneValue(selected.value) : undefined;
  const segments = pointer.slice(1).split('/').map(unescapePointerSegment);
  const result = isPlainRecord(root) ? cloneValue(root) : {};
  let cursor = result as Record<string, unknown>;
  for (const segment of segments.slice(0, -1)) {
    const next = cursor[segment];
    if (!isPlainRecord(next)) cursor[segment] = {};
    cursor = cursor[segment] as Record<string, unknown>;
  }
  const leaf = segments.at(-1);
  if (leaf === undefined) return result;
  if (selected.present) cursor[leaf] = cloneValue(selected.value);
  else delete cursor[leaf];
  return result;
}
