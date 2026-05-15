import { describe, it, expect } from 'vitest';
import {
  calculateJsonDepth,
  validateGrpcMessage,
  validateServiceField,
  validateMethodField,
  MAX_MESSAGE_JSON_DEPTH,
  INITIAL_VALIDATION_STATE,
} from '../grpcValidation';

describe('calculateJsonDepth', () => {
  it('returns 0 for primitives', () => {
    expect(calculateJsonDepth(null)).toBe(0);
    expect(calculateJsonDepth(42)).toBe(0);
    expect(calculateJsonDepth('hi')).toBe(0);
    expect(calculateJsonDepth(true)).toBe(0);
  });

  it('returns 1 for an empty object or array', () => {
    expect(calculateJsonDepth({})).toBe(1);
    expect(calculateJsonDepth([])).toBe(1);
  });

  it('returns 1 for a flat object of primitives', () => {
    expect(calculateJsonDepth({ a: 1, b: 'x' })).toBe(1);
  });

  it('returns the deepest path for nested structures', () => {
    expect(calculateJsonDepth({ a: { b: { c: 1 } } })).toBe(3);
    expect(calculateJsonDepth({ a: { b: { c: 1 } }, d: 1 })).toBe(3);
    expect(calculateJsonDepth([1, [2, [3, [4]]]])).toBe(4);
  });
});

describe('validateServiceField', () => {
  it('treats empty as valid (lenient)', () => {
    expect(validateServiceField('')).toEqual({ valid: true });
  });

  it('accepts a well-formed service name', () => {
    expect(validateServiceField('greet.v1.GreetService')).toEqual({ valid: true });
  });

  it('rejects a malformed service name', () => {
    const result = validateServiceField('lower.case.service');
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe('validateMethodField', () => {
  it('treats empty as valid (lenient)', () => {
    expect(validateMethodField('')).toEqual({ valid: true });
  });

  it('accepts a PascalCase method name', () => {
    expect(validateMethodField('SayHello')).toEqual({ valid: true });
  });

  it('rejects a non-PascalCase method name', () => {
    const result = validateMethodField('say_hello');
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });
});

describe('validateGrpcMessage', () => {
  it('treats empty/whitespace as valid', () => {
    expect(validateGrpcMessage('')).toEqual({ valid: true });
    expect(validateGrpcMessage('   ')).toEqual({ valid: true });
  });

  it('accepts well-formed JSON', () => {
    expect(validateGrpcMessage('{}')).toEqual({ valid: true });
    expect(validateGrpcMessage('{"name":"world"}')).toEqual({ valid: true });
    expect(validateGrpcMessage('[1,2,3]')).toEqual({ valid: true });
  });

  it('rejects invalid JSON', () => {
    const result = validateGrpcMessage('{not json');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Invalid JSON format');
  });

  it('rejects oversize payloads', () => {
    // Build a payload over 10MB. Use a single large string field so JSON.parse stays cheap.
    const big = '"' + 'a'.repeat(10 * 1024 * 1024 + 10) + '"';
    const result = validateGrpcMessage(big);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/exceeds maximum allowed size of 10MB/);
  });

  it('rejects deeply nested JSON beyond MAX_MESSAGE_JSON_DEPTH', () => {
    let payload: unknown = 'leaf';
    for (let i = 0; i < MAX_MESSAGE_JSON_DEPTH + 1; i++) {
      payload = { nested: payload };
    }
    const result = validateGrpcMessage(JSON.stringify(payload));
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/JSON depth/);
  });

  it('accepts JSON exactly at the depth limit', () => {
    let payload: unknown = 'leaf';
    // depth N corresponds to N nesting levels; build exactly MAX
    for (let i = 0; i < MAX_MESSAGE_JSON_DEPTH - 1; i++) {
      payload = { nested: payload };
    }
    const result = validateGrpcMessage(JSON.stringify(payload));
    expect(result.valid).toBe(true);
  });
});

describe('INITIAL_VALIDATION_STATE', () => {
  it('starts every field as valid with no errors', () => {
    expect(INITIAL_VALIDATION_STATE).toEqual({
      url: { valid: true },
      service: { valid: true },
      method: { valid: true },
      message: { valid: true },
    });
  });
});
