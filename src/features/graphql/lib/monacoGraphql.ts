import type * as Monaco from 'monaco-editor';

// Register GraphQL language with Monaco
export function registerGraphQLLanguage(monaco: typeof Monaco) {
  // Check if already registered
  const languages = monaco.languages.getLanguages();
  if (languages.some((lang) => lang.id === 'graphql')) {
    return;
  }

  // Register the language
  monaco.languages.register({
    id: 'graphql',
    extensions: ['.graphql', '.gql'],
    aliases: ['GraphQL', 'graphql'],
    mimetypes: ['application/graphql'],
  });

  // Define tokens for syntax highlighting
  monaco.languages.setMonarchTokensProvider('graphql', {
    keywords: [
      'query',
      'mutation',
      'subscription',
      'fragment',
      'on',
      'type',
      'interface',
      'union',
      'enum',
      'input',
      'extend',
      'scalar',
      'schema',
      'directive',
      'implements',
    ],

    typeKeywords: ['Int', 'Float', 'String', 'Boolean', 'ID'],

    operators: ['=', '!', '?', ':', '&', '|'],

    symbols: /[=!?:&|]+/,

    escapes: /\\(?:["\\/bfnrt]|u[0-9A-Fa-f]{4})/,

    tokenizer: {
      root: [
        // Comments
        [/#.*$/, 'comment'],

        // Strings
        [/"""/, 'string', '@multilineString'],
        [/"([^"\\]|\\.)*$/, 'string.invalid'],
        [/"/, 'string', '@string'],

        // Numbers
        [/-?\d+\.\d+([eE][+-]?\d+)?/, 'number.float'],
        [/-?\d+([eE][+-]?\d+)?/, 'number'],

        // Variables
        [/\$[a-zA-Z_]\w*/, 'variable'],

        // Directives
        [/@[a-zA-Z_]\w*/, 'annotation'],

        // Identifiers and keywords
        [
          /[a-zA-Z_]\w*/,
          {
            cases: {
              '@keywords': 'keyword',
              '@typeKeywords': 'type',
              '@default': 'identifier',
            },
          },
        ],

        // Delimiters
        [/[{}()\[\]]/, '@brackets'],
        [/[,:]/, 'delimiter'],

        // Operators
        [/@symbols/, 'operator'],

        // Whitespace
        [/\s+/, 'white'],
      ],

      string: [
        [/[^\\"]+/, 'string'],
        [/@escapes/, 'string.escape'],
        [/\\./, 'string.escape.invalid'],
        [/"/, 'string', '@pop'],
      ],

      multilineString: [
        [/[^"]+/, 'string'],
        [/"""/, 'string', '@pop'],
        [/"/, 'string'],
      ],
    },
  });

  // Define language configuration
  monaco.languages.setLanguageConfiguration('graphql', {
    comments: {
      lineComment: '#',
    },
    brackets: [
      ['{', '}'],
      ['[', ']'],
      ['(', ')'],
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"' },
      { open: '"""', close: '"""' },
    ],
    surroundingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"' },
    ],
    folding: {
      markers: {
        start: /^\s*#\s*region\b/,
        end: /^\s*#\s*endregion\b/,
      },
    },
    indentationRules: {
      increaseIndentPattern: /^\s*.*\{\s*$/,
      decreaseIndentPattern: /^\s*\}/,
    },
  });
}

// Define a custom theme for GraphQL (optional, uses default theme colors)
export function defineGraphQLTheme(monaco: typeof Monaco) {
  monaco.editor.defineTheme('graphql-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'keyword', foreground: 'AF00DB' },
      { token: 'type', foreground: '267F99' },
      { token: 'variable', foreground: '001080' },
      { token: 'annotation', foreground: '795E26' },
      { token: 'string', foreground: 'A31515' },
      { token: 'number', foreground: '098658' },
      { token: 'comment', foreground: '008000' },
    ],
    colors: {},
  });

  monaco.editor.defineTheme('graphql-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'keyword', foreground: 'C586C0' },
      { token: 'type', foreground: '4EC9B0' },
      { token: 'variable', foreground: '9CDCFE' },
      { token: 'annotation', foreground: 'DCDCAA' },
      { token: 'string', foreground: 'CE9178' },
      { token: 'number', foreground: 'B5CEA8' },
      { token: 'comment', foreground: '6A9955' },
    ],
    colors: {},
  });
}
