import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';

// Shared TypeScript overrides applied to all three environments (renderer, electron, worker).
// Defined once here to avoid duplicating the same rule set across multiple config objects.
const sharedTsRules = {
  '@typescript-eslint/consistent-type-imports': ['warn', { prefer: 'type-imports' }],
  '@typescript-eslint/no-unused-vars': [
    'error',
    { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
  ],
  // Phase 2 will eliminate these — warn so CI passes while work is in progress
  '@typescript-eslint/no-explicit-any': 'warn',
  // Empty interfaces are a common pattern in shadcn/ui component extensions
  '@typescript-eslint/no-empty-object-type': 'warn',
};

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', '.wrangler/**', 'scripts/**', '*.config.mts'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Renderer (src/): React rules + shared TS overrides
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: {
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
    },
    rules: {
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      'react/display-name': 'warn',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      ...sharedTsRules,
    },
    settings: {
      react: { version: '19' },
    },
  },
  // Non-renderer environments: shared TS overrides only
  {
    files: ['electron/main/**/*.ts', 'worker/**/*.ts'],
    rules: sharedTsRules,
  },
  // Electron main uses require() for CJS-only packages (electron-store, electron-squirrel-startup)
  {
    files: ['electron/main/**/*.ts'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  }
);
