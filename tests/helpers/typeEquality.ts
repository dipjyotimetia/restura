/**
 * Compile-time type-equality helpers for the shared/protocol ↔ renderer
 * "mirror" parity tests. These declarations are duplicated by design (the
 * shared protocol core must not import from `src/`); the parity tests assert
 * the two declarations haven't drifted.
 *
 * `Equals` is the standard invariant type-equality check; `expectTypeEqual`
 * fails to type-check unless its argument resolves to exactly `true`, so a
 * drifted pair turns `npm run type-check` red.
 */

/** Exact bidirectional (invariant) type equality. */
export type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** Compile-time assertion: only type-checks when `_T` is exactly `true`. */
export function expectTypeEqual<_T extends true>(): void {
  /* type-level only — no runtime behaviour */
}
