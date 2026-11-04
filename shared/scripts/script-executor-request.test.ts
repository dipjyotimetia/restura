import { describe, expect, it } from 'vitest';
import { collectEnabledHeaders } from '../protocol/request-spec';
import { applyScriptHeaderEdits } from './script-executor-request';

const rows = [
  { id: '1', key: 'X-A', value: '1', enabled: true },
  { id: '2', key: 'X-A', value: '2', enabled: true },
  { id: '3', key: 'Keep', value: 'k', enabled: true },
];
const before = collectEnabledHeaders(rows, (r) => r.value);
const wire = (next: typeof rows) => collectEnabledHeaders(next, (r) => r.value);

describe('applyScriptHeaderEdits — repeated header rows', () => {
  it('setting a repeated header leaves exactly one effective value', () => {
    const next = applyScriptHeaderEdits(rows, before, { ...before, 'X-A': '3' }, () => 'new');
    expect(wire(next)).toEqual({ 'X-A': '3', Keep: 'k' });
  });

  it('removing a repeated header removes every row', () => {
    const { 'X-A': _removed, ...after } = before;
    const next = applyScriptHeaderEdits(rows, before, after, () => 'new');
    expect(wire(next)).toEqual({ Keep: 'k' });
  });

  it('matches rows to edited names case-insensitively', () => {
    const mixed = [
      { id: '1', key: 'X-A', value: '1', enabled: true },
      { id: '2', key: 'x-a', value: '2', enabled: true },
    ];
    const b = collectEnabledHeaders(mixed, (r) => r.value);
    expect(b).toEqual({ 'X-A': '1, 2' });
    const next = applyScriptHeaderEdits(mixed, b, { 'X-A': '3' }, () => 'new');
    expect(wire(next)).toEqual({ 'X-A': '3' });
    expect(wire(applyScriptHeaderEdits(mixed, b, {}, () => 'new'))).toEqual({});
  });

  it('keeps untouched repeated rows (and their templates) as they were', () => {
    const next = applyScriptHeaderEdits(rows, before, { ...before }, () => 'new');
    expect(next).toEqual(rows);
  });
});
