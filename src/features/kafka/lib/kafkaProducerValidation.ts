export type OptionalSchemaIdValidation =
  | { valid: true; value: number | undefined }
  | { valid: false; error: string };

export function validateOptionalSchemaId(
  raw: string,
  field: 'Key' | 'Value'
): OptionalSchemaIdValidation {
  const value = raw.trim();
  if (!value) return { valid: true, value: undefined };

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return { valid: false, error: `${field} schema ID must be a positive safe integer.` };
  }
  return { valid: true, value: parsed };
}

export function validateJsonPayload(
  raw: string,
  field: 'Key' | 'Value'
): { valid: true } | { valid: false; error: string } {
  try {
    JSON.parse(raw);
    return { valid: true };
  } catch {
    return { valid: false, error: `${field} JSON must be valid JSON.` };
  }
}

export type KafkaHeaderInput = { key: string; value: string; enabled: boolean };

export function validateKafkaHeaders(
  headers: KafkaHeaderInput[]
): { valid: true; value: Record<string, string> } | { valid: false; error: string } {
  const value: Record<string, string> = {};
  for (const header of headers) {
    if (!header.enabled) continue;
    const key = header.key.trim();
    if (!key) return { valid: false, error: 'Kafka header names cannot be blank.' };
    if (Object.hasOwn(value, key))
      return { valid: false, error: 'Kafka header names must be unique.' };
    value[key] = header.value;
  }
  return { valid: true, value };
}
