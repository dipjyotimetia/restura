import { describe, expect, it } from 'vitest';
import type { DatasetCaseInput } from '../datasetIo';
import { casesFromCsv, casesFromJsonl, casesToCsv, casesToJsonl, coerceSplit } from '../datasetIo';

const CASES: DatasetCaseInput[] = [
  { vars: { country: 'France' }, expected: 'Paris' },
  { vars: { country: 'Japan' }, reference: 'Tokyo is the capital' },
];

describe('JSONL round-trip', () => {
  it('serializes and parses back', () => {
    const jsonl = casesToJsonl(CASES);
    expect(jsonl.split('\n')).toHaveLength(2);
    expect(casesFromJsonl(jsonl)).toEqual(CASES);
  });

  it('skips blank lines and preserves turns', () => {
    const withTurns = casesToJsonl([{ vars: {}, turns: [{ role: 'user', content: 'hi' }] }]);
    const parsed = casesFromJsonl(`\n${withTurns}\n`);
    expect(parsed[0]!.turns).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('throws on a malformed line', () => {
    expect(() => casesFromJsonl('{bad')).toThrow();
  });

  it('round-trips the held-out split tag and drops unknown values', () => {
    const jsonl = casesToJsonl([{ vars: { q: '1' }, split: 'test' }, { vars: { q: '2' } }]);
    const parsed = casesFromJsonl(jsonl);
    expect(parsed[0]!.split).toBe('test');
    expect(parsed[1]!.split).toBeUndefined();
    expect(casesFromJsonl('{"vars":{},"split":"TRAIN "}')[0]!.split).toBe('train');
    expect(casesFromJsonl('{"vars":{},"split":"holdout"}')[0]!.split).toBeUndefined();
    expect(coerceSplit(3)).toBeUndefined();
  });
});

describe('CSV round-trip', () => {
  it('serializes vars + expected/reference columns', () => {
    const csv = casesToCsv(CASES);
    const back = casesFromCsv(csv);
    expect(back[0]!.vars.country).toBe('France');
    expect(back[0]!.expected).toBe('Paris');
    expect(back[1]!.reference).toBe('Tokyo is the capital');
  });

  it('handles quoted fields with commas and newlines', () => {
    const csv = casesToCsv([{ vars: { note: 'a, b\nc' }, expected: 'x' }]);
    const back = casesFromCsv(csv);
    expect(back[0]!.vars.note).toBe('a, b\nc');
  });

  it('carries the split as a reserved column, not a variable', () => {
    const csv = casesToCsv([{ vars: { q: 'a' }, split: 'test' }, { vars: { q: 'b' } }]);
    expect(csv.split(/\r?\n/)[0]).toBe('q,expected,reference,split');
    const back = casesFromCsv(csv);
    expect(back[0]).toEqual({ vars: { q: 'a' }, split: 'test' });
    expect(back[1]).toEqual({ vars: { q: 'b' } });
    expect(back[1]!.vars.split).toBeUndefined();
  });

  it('escapes embedded double quotes', () => {
    const csv = casesToCsv([{ vars: { q: 'say "hi"' } }]);
    const back = casesFromCsv(csv);
    expect(back[0]!.vars.q).toBe('say "hi"');
  });
});
