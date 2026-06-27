import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { VariableText, type VariableStatus } from '../VariableText';

describe('VariableText', () => {
  it('renders plain text without any variable tokens', () => {
    const { container } = render(<VariableText text="https://example.com/users" />);
    expect(container.querySelectorAll('.sp-variable')).toHaveLength(0);
    expect(container.querySelectorAll('.sp-variable-unresolved')).toHaveLength(0);
    expect(container.textContent).toBe('https://example.com/users');
  });

  it('highlights a {{var}} token with the amber style by default', () => {
    const { container } = render(<VariableText text="{{baseUrl}}/json" />);
    const tokens = container.querySelectorAll('.sp-variable');
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.textContent).toBe('{{baseUrl}}');
    // No classifier supplied → never flagged unresolved.
    expect(container.querySelectorAll('.sp-variable-unresolved')).toHaveLength(0);
  });

  it('flags an unresolved token with the warning style and a title', () => {
    const getStatus = (name: string): VariableStatus =>
      name === 'baseUrl' ? 'resolved' : 'unresolved';
    const { container } = render(<VariableText text="{{missing}}/json" getStatus={getStatus} />);
    const warn = container.querySelector('.sp-variable-unresolved');
    expect(warn).not.toBeNull();
    expect(warn?.textContent).toBe('{{missing}}');
    expect(warn?.getAttribute('title')).toContain('missing');
    expect(container.querySelectorAll('.sp-variable')).toHaveLength(0);
  });

  it('classifies each token independently (regression: stateful /g regex)', () => {
    // `{{a}}` resolved, `{{b}}` unresolved. The old split()+test() code reused a
    // global regex whose lastIndex advanced between calls, which could
    // misclassify adjacent tokens. matchAll() segmentation must keep them
    // independent.
    const getStatus = (name: string): VariableStatus => (name === 'a' ? 'resolved' : 'unresolved');
    const { container } = render(<VariableText text="{{a}}-{{b}}-{{a}}" getStatus={getStatus} />);
    const resolved = container.querySelectorAll('.sp-variable');
    const unresolved = container.querySelectorAll('.sp-variable-unresolved');
    expect(resolved).toHaveLength(2); // both {{a}}
    expect(unresolved).toHaveLength(1); // {{b}}
    expect(unresolved[0]?.textContent).toBe('{{b}}');
    // Literal separators survive intact.
    expect(container.textContent).toBe('{{a}}-{{b}}-{{a}}');
  });

  it('recognises dynamic `{{ $helper }}` tokens with surrounding spaces', () => {
    const seen: string[] = [];
    const getStatus = (name: string): VariableStatus => {
      seen.push(name);
      return 'resolved';
    };
    render(<VariableText text="{{ $randomUUID }}" getStatus={getStatus} />);
    // Inner name is trimmed and brace-stripped before classification.
    expect(seen).toContain('$randomUUID');
  });

  it('renders the empty label when text is blank', () => {
    const { container } = render(<VariableText text="" emptyLabel="(none)" />);
    expect(container.textContent).toBe('(none)');
  });
});
