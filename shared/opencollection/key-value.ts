import { v4 as uuid } from 'uuid';
import type { KeyValue } from '../types';

/** Internal `KeyValue` → OC header/param/metadata row (`{ name, value }`). */
export function kvFromInternal(k: KeyValue): unknown {
  const out: Record<string, unknown> = {
    name: k.key,
    value: k.value,
  };
  // Emit `enabled: false` so a disabled header/param/metadata round-trips as
  // disabled rather than vanishing on re-import. (The OC httpHeader/httpParam
  // schema carries `enabled`, defaulting to true.)
  if (k.enabled === false) out.enabled = false;
  if (k.description) out.description = k.description;
  return out;
}

/** OC row → internal `KeyValue`; tolerates the legacy `key` spelling. Ids are minted fresh. */
export function kvToInternal(kv: unknown): KeyValue {
  const k = (kv ?? {}) as Record<string, unknown>;
  const out: KeyValue = {
    id: uuid(),
    key: (k.name as string) ?? (k.key as string) ?? '',
    value: (k.value as string) ?? '',
    enabled: typeof k.enabled === 'boolean' ? (k.enabled as boolean) : true,
  };
  if (typeof k.description === 'string') out.description = k.description;
  return out;
}
