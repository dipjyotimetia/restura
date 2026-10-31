import type { CollectionRequest } from '../types';

/**
 * One place a saved request can hold a Secret, with both things export does to
 * it: blanking (the file the user shares) and counting (the warning before it
 * is written). Both are required, so a slot cannot be blanked but not counted,
 * or counted but not blanked. The list is `REQUEST_SECRET_SLOTS`.
 */
export interface SecretSlot<R = CollectionRequest> {
  readonly name: string;
  /** Returns a copy with this slot blanked. Never mutates `request`. */
  blank(request: R): R;
  /** Plaintext secrets `blank` would remove. Handle references never count. */
  count(request: R): number;
}

type RequestKind = CollectionRequest['type'];
type RequestOfKind<K extends RequestKind> = Extract<CollectionRequest, { type: K }>;

/** Slots that exist on one request kind. Named `<kind>.<name>`; other kinds pass through. */
export function slotsForKind<K extends RequestKind>(
  kind: K,
  slots: ReadonlyArray<SecretSlot<RequestOfKind<K>>>
): SecretSlot[] {
  const isKind = (request: CollectionRequest): request is RequestOfKind<K> => request.type === kind;
  return slots.map((slot) => ({
    name: `${kind}.${slot.name}`,
    blank: (request) => (isKind(request) ? slot.blank(request) : request),
    count: (request) => (isKind(request) ? slot.count(request) : 0),
  }));
}

export function blankSecretSlots<T extends CollectionRequest>(
  slots: readonly SecretSlot[],
  request: T
): T {
  return slots.reduce<CollectionRequest>((next, slot) => slot.blank(next), request) as T;
}

export function countSecretSlots(slots: readonly SecretSlot[], request: CollectionRequest): number {
  return slots.reduce((n, slot) => n + slot.count(request), 0);
}
