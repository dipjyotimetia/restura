import { describe, expect, it, vi } from 'vitest';
import { registerGraphQLLanguage } from '../monacoGraphql';

describe('registerGraphQLLanguage', () => {
  it('configures GraphQL when another integration already registered its language id', () => {
    const languages = {
      getLanguages: () => [{ id: 'graphql' }],
      register: vi.fn(),
      setMonarchTokensProvider: vi.fn(),
      setLanguageConfiguration: vi.fn(),
    };
    const monaco = { languages } as unknown as typeof import('monaco-editor');

    registerGraphQLLanguage(monaco);

    expect(languages.register).not.toHaveBeenCalled();
    expect(languages.setMonarchTokensProvider).toHaveBeenCalledWith('graphql', expect.any(Object));
    expect(languages.setLanguageConfiguration).toHaveBeenCalledWith('graphql', expect.any(Object));
  });

  it('installs GraphQL language services only once for a Monaco instance', () => {
    const languages = {
      getLanguages: () => [],
      register: vi.fn(),
      setMonarchTokensProvider: vi.fn(),
      setLanguageConfiguration: vi.fn(),
    };
    const monaco = { languages } as unknown as typeof import('monaco-editor');

    registerGraphQLLanguage(monaco);
    registerGraphQLLanguage(monaco);

    expect(languages.register).toHaveBeenCalledTimes(1);
    expect(languages.setMonarchTokensProvider).toHaveBeenCalledTimes(1);
    expect(languages.setLanguageConfiguration).toHaveBeenCalledTimes(1);
  });
});
