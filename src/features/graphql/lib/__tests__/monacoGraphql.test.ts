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
});
