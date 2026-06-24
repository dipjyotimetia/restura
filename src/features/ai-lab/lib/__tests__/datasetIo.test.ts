import { describe, it, expect } from 'vitest';
import { casesFromCsv, casesFromJsonl, casesToCsv, casesToJsonl } from '../datasetIo';
import type { DatasetCaseInput } from '../datasetIo';

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

  it('escapes embedded double quotes', () => {
    const csv = casesToCsv([{ vars: { q: 'say "hi"' } }]);
    const back = casesFromCsv(csv);
    expect(back[0]!.vars.q).toBe('say "hi"');
  });
});
