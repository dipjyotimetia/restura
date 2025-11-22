import type * as Monaco from 'monaco-editor';
import { GraphQLSchema, GraphQLField, formatTypeRef } from '../types';
import { getTypeFields } from './introspection';

// Register completion provider for GraphQL
export function registerGraphQLCompletionProvider(
  monaco: typeof Monaco,
  getSchema: () => GraphQLSchema | null
): Monaco.IDisposable {
  return monaco.languages.registerCompletionItemProvider('graphql', {
    triggerCharacters: ['{', '(', '$', '@', ':', ' '],

    provideCompletionItems: (model, position) => {
      const schema = getSchema();
      if (!schema) {
        return { suggestions: [] };
      }

      const textUntilPosition = model.getValueInRange({
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      });

      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      const suggestions: Monaco.languages.CompletionItem[] = [];

      // Determine context and provide appropriate completions
      const context = getCompletionContext(textUntilPosition);

      switch (context.type) {
        case 'root':
          suggestions.push(...getRootOperationSuggestions(monaco, range));
          break;

        case 'operation':
          suggestions.push(
            ...getFieldSuggestions(monaco, schema, context.typeName, range)
          );
          break;

        case 'field':
          suggestions.push(
            ...getFieldSuggestions(monaco, schema, context.typeName, range)
          );
          break;

        case 'argument':
          suggestions.push(
            ...getArgumentSuggestions(monaco, schema, context.typeName, context.fieldName, range)
          );
          break;

        case 'directive':
          suggestions.push(...getDirectiveSuggestions(monaco, schema, range));
          break;

        case 'type':
          suggestions.push(...getTypeSuggestions(monaco, schema, range));
          break;
      }

      return { suggestions };
    },
  });
}

interface CompletionContext {
  type: 'root' | 'operation' | 'field' | 'argument' | 'directive' | 'type';
  typeName?: string;
  fieldName?: string;
}

function getCompletionContext(text: string): CompletionContext {
  // Simplified context detection
  const trimmed = text.trim();

  // At root level
  if (!trimmed || /^(#.*\n)*$/.test(trimmed)) {
    return { type: 'root' };
  }

  // After @
  if (/@\w*$/.test(trimmed)) {
    return { type: 'directive' };
  }

  // In type position (after :)
  if (/:\s*\w*$/.test(trimmed)) {
    return { type: 'type' };
  }

  // After opening brace of query/mutation/subscription
  const operationMatch = trimmed.match(/(query|mutation|subscription)\s*\w*\s*(?:\([^)]*\))?\s*\{/);
  if (operationMatch) {
    const operationType = operationMatch[1];
    const typeName = operationType === 'query' ? 'Query' : operationType === 'mutation' ? 'Mutation' : 'Subscription';
    return { type: 'operation', typeName };
  }

  // Default to field context
  return { type: 'field', typeName: 'Query' };
}

function getRootOperationSuggestions(
  monaco: typeof Monaco,
  range: Monaco.IRange
): Monaco.languages.CompletionItem[] {
  return [
    {
      label: 'query',
      kind: monaco.languages.CompletionItemKind.Keyword,
      insertText: 'query ${1:QueryName} {\n  $0\n}',
      insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
      documentation: 'GraphQL query operation',
      range,
    },
    {
      label: 'mutation',
      kind: monaco.languages.CompletionItemKind.Keyword,
      insertText: 'mutation ${1:MutationName} {\n  $0\n}',
      insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
      documentation: 'GraphQL mutation operation',
      range,
    },
    {
      label: 'subscription',
      kind: monaco.languages.CompletionItemKind.Keyword,
      insertText: 'subscription ${1:SubscriptionName} {\n  $0\n}',
      insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
      documentation: 'GraphQL subscription operation',
      range,
    },
    {
      label: 'fragment',
      kind: monaco.languages.CompletionItemKind.Keyword,
      insertText: 'fragment ${1:FragmentName} on ${2:Type} {\n  $0\n}',
      insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
      documentation: 'GraphQL fragment definition',
      range,
    },
  ];
}

function getFieldSuggestions(
  monaco: typeof Monaco,
  schema: GraphQLSchema,
  typeName: string | undefined,
  range: Monaco.IRange
): Monaco.languages.CompletionItem[] {
  if (!typeName) return [];

  const fields = getTypeFields(schema, typeName);

  return fields.map((field: GraphQLField) => {
    const hasArgs = field.args && field.args.length > 0;
    const typeStr = formatTypeRef(field.type);

    return {
      label: field.name,
      kind: monaco.languages.CompletionItemKind.Field,
      insertText: hasArgs ? `${field.name}($0)` : field.name,
      insertTextRules: hasArgs
        ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
        : undefined,
      detail: typeStr,
      documentation: field.description || undefined,
      range,
    };
  });
}

function getArgumentSuggestions(
  monaco: typeof Monaco,
  schema: GraphQLSchema,
  typeName: string | undefined,
  fieldName: string | undefined,
  range: Monaco.IRange
): Monaco.languages.CompletionItem[] {
  if (!typeName || !fieldName) return [];

  const fields = getTypeFields(schema, typeName);
  const field = fields.find((f: GraphQLField) => f.name === fieldName);

  if (!field || !field.args) return [];

  return field.args.map((arg) => {
    const typeStr = formatTypeRef(arg.type);

    return {
      label: arg.name,
      kind: monaco.languages.CompletionItemKind.Property,
      insertText: `${arg.name}: $0`,
      insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
      detail: typeStr,
      documentation: arg.description || undefined,
      range,
    };
  });
}

function getDirectiveSuggestions(
  monaco: typeof Monaco,
  schema: GraphQLSchema,
  range: Monaco.IRange
): Monaco.languages.CompletionItem[] {
  return schema.directives.map((directive) => ({
    label: `@${directive.name}`,
    kind: monaco.languages.CompletionItemKind.Function,
    insertText: directive.args.length > 0
      ? `@${directive.name}($0)`
      : `@${directive.name}`,
    insertTextRules: directive.args.length > 0
      ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
      : undefined,
    detail: `Directive`,
    documentation: directive.description || undefined,
    range,
  }));
}

function getTypeSuggestions(
  monaco: typeof Monaco,
  schema: GraphQLSchema,
  range: Monaco.IRange
): Monaco.languages.CompletionItem[] {
  return schema.types
    .filter((type) => type.name && !type.name.startsWith('__'))
    .map((type) => ({
      label: type.name!,
      kind: monaco.languages.CompletionItemKind.Class,
      insertText: type.name!,
      detail: type.kind,
      documentation: type.description || undefined,
      range,
    }));
}
