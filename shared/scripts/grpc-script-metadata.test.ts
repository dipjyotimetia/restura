import { describe, expect, it } from 'vitest';
import type { KeyValue } from '../types';
import { applyScriptMetadata, grpcMetadataForScript } from './grpc-script-metadata';

const kv = (key: string, value: string, enabled = true): KeyValue => ({
  id: `id-${key}-${value}`,
  key,
  value,
  enabled,
});

describe('grpcMetadataForScript', () => {
  it('exposes enabled, keyed entries lowercased with resolved values', () => {
    const out = grpcMetadataForScript(
      [kv('X-Tenant', '{{t}}'), kv('x-off', '1', false), kv('', 'orphan')],
      (s) => s.replace('{{t}}', 'acme')
    );
    expect(out).toEqual({ 'x-tenant': 'acme' });
  });
});

describe('applyScriptMetadata', () => {
  const resolve = (s: string) => s.replace('{{t}}', 'acme');

  it('keeps unchanged entries verbatim (variable templates survive)', () => {
    const md = [kv('X-Tenant', '{{t}}')];
    const next = applyScriptMetadata(md, { 'x-tenant': 'acme', 'x-new': 'n' }, resolve);
    expect(next[0]).toEqual(md[0]);
    expect(next[1]).toMatchObject({ key: 'x-new', value: 'n', enabled: true });
  });

  it('updates edited values and disables entries the script deleted', () => {
    const md = [kv('x-a', '1'), kv('x-b', '2'), kv('x-c', '3', false)];
    const next = applyScriptMetadata(md, { 'x-a': 'changed' }, resolve);
    expect(next).toEqual([{ ...md[0], value: 'changed' }, { ...md[1], enabled: false }, md[2]]);
  });

  it('collapses duplicate enabled keys onto the script value', () => {
    const md = [kv('x-a', '1'), kv('X-A', '2')];
    const next = applyScriptMetadata(md, { 'x-a': '9' }, resolve);
    expect(next.filter((m) => m.enabled)).toEqual([{ ...md[0], value: '9' }]);
  });

  it('applies a mixed-case script write over the existing lowercase key', () => {
    const md = [kv('authorization', 'old')];
    const next = applyScriptMetadata(md, { authorization: 'old', Authorization: 'new' }, resolve);
    expect(next).toEqual([{ ...md[0], value: 'new' }]);
  });

  it('keeps an unchanged lowercase value when a mixed-case alias repeats it', () => {
    const md = [kv('x-a', '1')];
    const next = applyScriptMetadata(md, { 'X-A': '1', 'x-a': '1' }, resolve);
    expect(next).toEqual(md);
  });

  it('preserves unchanged duplicate entries while another key changes', () => {
    const md = [kv('x-tag', '{{t}}'), kv('X-Tag', 'b'), kv('x-other', '1')];
    const final = { ...grpcMetadataForScript(md, resolve), 'x-other': '2' };
    const next = applyScriptMetadata(md, final, resolve);
    expect(next).toEqual([md[0], md[1], { ...md[2], value: '2' }]);
  });
});
