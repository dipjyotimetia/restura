import { describe, expect, it } from 'vitest';
import {
  expandUriTemplate,
  getUriTemplateVariables,
  isOptionalUriTemplateVariable,
} from '../uriTemplate';

describe('uriTemplate', () => {
  it('extracts distinct variable names in order', () => {
    expect(getUriTemplateVariables('file:///{dir}/{name}{?v,lang}/{dir}')).toEqual([
      'dir',
      'name',
      'v',
      'lang',
    ]);
    expect(getUriTemplateVariables('https://x/static')).toEqual([]);
  });

  it('expands level 1 and percent-encodes reserved characters', () => {
    expect(expandUriTemplate('users://{id}/profile', { id: 'a b/c?d' })).toBe(
      'users://a%20b%2Fc%3Fd/profile'
    );
    expect(expandUriTemplate('x://{v}', { v: "it's (1)*!" })).toBe('x://it%27s%20%281%29%2A%21');
    expect(expandUriTemplate('x://{v}', { v: 'é' })).toBe('x://%C3%A9');
  });

  it('level 2 reserved expansion keeps reserved chars and existing pct triplets', () => {
    expect(expandUriTemplate('file://{+path}', { path: '/a b/c%20d' })).toBe('file:///a%20b/c%20d');
    expect(expandUriTemplate('x{#frag}', { frag: 'a/b c' })).toBe('x#a/b%20c');
  });

  it('supports label, path, param, query and continuation operators', () => {
    const v = { a: 'x y', b: '' };
    expect(expandUriTemplate('d{.a}', v)).toBe('d.x%20y');
    expect(expandUriTemplate('d{/a,b}', v)).toBe('d/x%20y/');
    expect(expandUriTemplate('d{;a,b}', v)).toBe('d;a=x%20y;b');
    expect(expandUriTemplate('d{?a,b}', v)).toBe('d?a=x%20y&b=');
    expect(expandUriTemplate('d?z=1{&a}', v)).toBe('d?z=1&a=x%20y');
  });

  it('skips undefined variables and honours prefix modifiers', () => {
    expect(expandUriTemplate('d{?a,b}', { b: '1' })).toBe('d?b=1');
    expect(expandUriTemplate('d{?a}', {})).toBe('d');
    expect(expandUriTemplate('{name:3}', { name: 'abcdef' })).toBe('abc');
    expect(expandUriTemplate('{name*}', { name: 'abc' })).toBe('abc');
  });

  it('keeps malformed expressions literal', () => {
    expect(expandUriTemplate('a{b c}d{', { b: '1' })).toBe('a{b c}d{');
  });

  it('flags only form-style variables as optional', () => {
    expect(isOptionalUriTemplateVariable('x/{id}{?page}', 'id')).toBe(false);
    expect(isOptionalUriTemplateVariable('x/{id}{?page}', 'page')).toBe(true);
  });
});
