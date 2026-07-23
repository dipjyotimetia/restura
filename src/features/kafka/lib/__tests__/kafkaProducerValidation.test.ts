import { describe, expect, it } from 'vitest';
import {
  validateJsonPayload,
  validateKafkaHeaders,
  validateOptionalSchemaId,
} from '../kafkaProducerValidation';

describe('validateOptionalSchemaId', () => {
  it('accepts an empty schema id as plain payload mode', () => {
    expect(validateOptionalSchemaId('', 'Value')).toEqual({ valid: true, value: undefined });
  });

  it('accepts a positive safe integer', () => {
    expect(validateOptionalSchemaId('42', 'Key')).toEqual({ valid: true, value: 42 });
  });

  it.each([
    '0',
    '-1',
    '1.5',
    'invalid',
    '9007199254740992',
  ])('rejects an invalid non-empty schema id: %s', (raw) => {
    expect(validateOptionalSchemaId(raw, 'Value')).toEqual({
      valid: false,
      error: 'Value schema ID must be a positive safe integer.',
    });
  });
});

describe('validateKafkaHeaders', () => {
  it('returns only enabled headers', () => {
    expect(
      validateKafkaHeaders([
        { key: 'trace-id', value: 'abc', enabled: true },
        { key: 'ignored', value: 'no', enabled: false },
      ])
    ).toEqual({ valid: true, value: { 'trace-id': 'abc' } });
  });

  it('rejects duplicate or blank enabled names', () => {
    expect(validateKafkaHeaders([{ key: ' ', value: 'x', enabled: true }])).toEqual({
      valid: false,
      error: 'Kafka header names cannot be blank.',
    });
    expect(
      validateKafkaHeaders([
        { key: 'trace-id', value: 'a', enabled: true },
        { key: 'trace-id', value: 'b', enabled: true },
      ])
    ).toEqual({ valid: false, error: 'Kafka header names must be unique.' });
  });
});

describe('validateJsonPayload', () => {
  it('accepts valid JSON without changing the exact text sent to Kafka', () => {
    expect(validateJsonPayload('{\n  "id": 1\n}', 'Value')).toEqual({ valid: true });
  });

  it('rejects malformed JSON with a field-specific message', () => {
    expect(validateJsonPayload('{oops', 'Key')).toEqual({
      valid: false,
      error: 'Key JSON must be valid JSON.',
    });
  });
});
