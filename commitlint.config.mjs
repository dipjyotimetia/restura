/** @type {import('@commitlint/types').UserConfig} */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // Slightly looser body width — Conventional Commits default truncates rich PR descriptions.
    'body-max-line-length': [1, 'always', 200],
    // Allow the scopes we actually use in this repo. Empty means any scope is allowed.
    'scope-enum': [
      0,
      'always',
      [
        'ai',
        'auth',
        'cli',
        'ci',
        'collections',
        'console',
        'deps',
        'docs',
        'e2e',
        'electron',
        'graphql',
        'grpc',
        'http',
        'kafka',
        'mcp',
        'release',
        'scripts',
        'security',
        'shared',
        'socketio',
        'sse',
        'tests',
        'ui',
        'websocket',
        'worker',
        'workflows',
      ],
    ],
  },
};
