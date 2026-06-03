import { describe, it, expect } from 'vitest';
import { renderTemplate, extractVars, missingVars } from '../promptTemplate';

describe('renderTemplate', () => {
  it('substitutes named placeholders', () => {
    expect(renderTemplate('Hello {{name}}, you are {{age}}', { name: 'Sam', age: '30' })).toBe(
      'Hello Sam, you are 30'
    );
  });

  it('tolerates whitespace inside braces', () => {
    expect(renderTemplate('{{ greeting }} world', { greeting: 'hi' })).toBe('hi world');
  });

  it('renders an unknown placeholder as empty', () => {
    expect(renderTemplate('a {{missing}} b', {})).toBe('a  b');
  });
});

describe('extractVars / missingVars', () => {
  it('lists distinct vars in first-seen order', () => {
    expect(extractVars('{{a}} {{b}} {{a}}')).toEqual(['a', 'b']);
  });

  it('reports vars not supplied by the case', () => {
    expect(missingVars('{{a}} {{b}}', { a: '1' })).toEqual(['b']);
  });
});
