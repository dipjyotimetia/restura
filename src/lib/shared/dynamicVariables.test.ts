import { describe, it, expect } from 'vitest';
import { applyDynamicVariables } from './dynamicVariables';

describe('applyDynamicVariables', () => {
  it('expands $timestamp', () => {
    const out = applyDynamicVariables('ts={{$timestamp}}');
    expect(out).toMatch(/^ts=\d{10,}$/);
  });

  it('expands $isoTimestamp', () => {
    const out = applyDynamicVariables('t={{$isoTimestamp}}');
    expect(out).toMatch(/^t=\d{4}-\d{2}-\d{2}T/);
  });

  it('expands $randomInt within default range', () => {
    const out = applyDynamicVariables('n={{$randomInt}}');
    const match = out.match(/^n=(\d+)$/);
    expect(match).not.toBeNull();
    const n = Number(match![1]);
    expect(n).toBeGreaterThanOrEqual(0);
    expect(n).toBeLessThan(1000);
  });

  it('expands $guid as a UUID v4', () => {
    const out = applyDynamicVariables('id={{$guid}}');
    expect(out).toMatch(/^id=[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('expands $randomUUID as a UUID v4 (Postman alias of $guid)', () => {
    const out = applyDynamicVariables('id={{$randomUUID}}');
    expect(out).toMatch(/^id=[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('expands $randomEmail to a syntactically valid email', () => {
    const out = applyDynamicVariables('email={{$randomEmail}}');
    expect(out).toMatch(/^email=[a-z]+\.\d+@[a-z]+\.[a-z]+$/);
  });

  it('expands $randomAlphaNumeric', () => {
    const out = applyDynamicVariables('s={{$randomAlphaNumeric}}');
    expect(out).toMatch(/^s=[a-z0-9]+$/);
  });

  it('leaves unknown $-prefixed variables untouched', () => {
    const out = applyDynamicVariables('x={{$unknownThing}}');
    expect(out).toBe('x={{$unknownThing}}');
  });

  it('handles whitespace around the variable name', () => {
    const out = applyDynamicVariables('a={{ $timestamp }}');
    expect(out).toMatch(/^a=\d{10,}$/);
  });

  it('expands multiple instances in one string', () => {
    const out = applyDynamicVariables('{{$randomUUID}}-{{$randomUUID}}');
    // Each UUID has 4 internal hyphens × 2 UUIDs = 8 internal + 1 separator = 9 hyphens
    // → split('-') yields 10 segments
    const parts = out.split('-');
    expect(parts).toHaveLength(10);
  });

  it('leaves regular {{var}} (no $-prefix) untouched', () => {
    const out = applyDynamicVariables('x={{regularVar}}');
    expect(out).toBe('x={{regularVar}}');
  });
});
