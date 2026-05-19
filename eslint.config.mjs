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
  // Strict: every new any requires an inline disable with a TODO
  '@typescript-eslint/no-explicit-any': 'error',
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
    files: ['electron/main/**/*.ts', 'worker/**/*.ts', 'echo/**/*.ts'],
    rules: sharedTsRules,
  },
  // Electron main uses require() for CJS-only packages (electron-store, electron-squirrel-startup)
  {
    files: ['electron/main/**/*.ts'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  // Keep the eagerly-loaded workflow executor + helpers free of React Flow.
  // The graph canvas (`flow-canvas/`) is lazy-loaded so users who never open
  // the Graph tab don't pay the bundle cost. An accidental eager import from
  // anywhere in `lib/**` would defeat the split — this rule catches it at
  // CI time.
  {
    files: ['src/features/workflows/lib/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/flow-canvas/**', '**/components/flow-canvas/**'],
              message:
                'src/features/workflows/lib/** must not import from flow-canvas/** — the canvas is lazy-loaded, eager imports defeat the split.',
            },
            {
              group: ['@xyflow/react', '@dagrejs/dagre', 'dagre'],
              message:
                'React Flow / dagre belong only to the lazy flow-canvas chunk. Move this code there.',
            },
          ],
        },
      ],
    },
  }
);
