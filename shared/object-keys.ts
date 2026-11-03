/**
 * Runtime-keyed property access, for walks driven by a key list the static
 * type cannot name: a secret-field map, a union's tag used as a key, the
 * per-protocol row keys of a saved request.
 *
 * Reads come back `unknown`, so the caller narrows what it found. Writes say
 * plainly that they bypass the property's declared type, in one place,
 * instead of a double cast at each call site. When the key is static, use a
 * typed property access instead.
 */

/** The value at `key`, or `undefined` when absent. */
export function readKey(target: object, key: PropertyKey): unknown {
  return Reflect.get(target, key);
}

/**
 * Sets `key` on `target` in place. Throws like a strict-mode assignment when
 * the property cannot be written (frozen object, getter-only property).
 */
export function writeKey(target: object, key: PropertyKey, value: unknown): void {
  if (!Reflect.set(target, key, value)) {
    throw new TypeError(`Cannot assign to property '${String(key)}'`);
  }
}

/** Shallow copy of `target` with `key` set to `value`. */
export function withKey<T extends object>(target: T, key: PropertyKey, value: unknown): T {
  const copy = { ...target };
  writeKey(copy, key, value);
  return copy;
}
