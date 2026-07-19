import { describe, expect, it } from 'vitest';
import { isValidManualOffset } from '../kafkaConsumerValidation';

describe('isValidManualOffset', () => {
  it('accepts a non-negative offset and a valid Kafka partition', () => {
    expect(isValidManualOffset('2147483647', '0')).toBe(true);
  });

  it('rejects decimals, negatives, and partitions outside the signed 32-bit range', () => {
    expect(isValidManualOffset('1.5', '0')).toBe(false);
    expect(isValidManualOffset('-1', '0')).toBe(false);
    expect(isValidManualOffset('2147483648', '0')).toBe(false);
    expect(isValidManualOffset('0', '-1')).toBe(false);
  });
});
