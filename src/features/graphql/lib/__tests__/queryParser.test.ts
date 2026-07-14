import { describe, expect, it } from 'vitest';
import {
  buildGraphQLRequestBody,
  extractGraphQLErrors,
  extractOperationName,
  extractOperationType,
  generateDefaultValue,
  generateVariablesTemplate,
  parseVariables,
  validateGraphQLSyntax,
} from '../queryParser';

describe('parseVariables', () => {
  it('parses a single required variable', () => {
    const vars = parseVariables('query GetUser($id: ID!) { user(id: $id) { name } }');
    expect(vars).toHaveLength(1);
    expect(vars[0]).toMatchObject({ name: 'id', type: 'ID!', isRequired: true });
  });

  it('parses multiple variables', () => {
    const vars = parseVariables(
      'query Search($term: String!, $limit: Int = 10) { search(term: $term, limit: $limit) { id } }'
    );
    expect(vars).toHaveLength(2);
    expect(vars[0]).toMatchObject({ name: 'term', type: 'String!', isRequired: true });
    expect(vars[1]).toMatchObject({
      name: 'limit',
      type: 'Int',
      isRequired: false,
      defaultValue: '10',
    });
  });

  it('parses list type variables', () => {
    const vars = parseVariables(
      'mutation CreateItems($items: [ItemInput!]!) { createItems(items: $items) { id } }'
    );
    expect(vars).toHaveLength(1);
    expect(vars[0]).toMatchObject({ name: 'items', type: '[ItemInput!]!', isRequired: true });
  });

  it('returns empty array for query with no variables', () => {
    const vars = parseVariables('query AllUsers { users { id name } }');
    expect(vars).toHaveLength(0);
  });

  it('returns empty array for empty query', () => {
    expect(parseVariables('')).toHaveLength(0);
  });

  it('parses subscription variables', () => {
    const vars = parseVariables(
      'subscription OnMessage($roomId: String!) { messageAdded(roomId: $roomId) { text } }'
    );
    expect(vars).toHaveLength(1);
    expect(vars[0]).toMatchObject({ name: 'roomId', type: 'String!' });
  });
});

describe('generateDefaultValue', () => {
  it.each([
    ['String', ''],
    ['String!', ''],
    ['Int', 0],
    ['Int!', 0],
    ['Float', 0.0],
    ['Boolean', false],
    ['ID', ''],
  ])('returns correct default for %s', (type, expected) => {
    expect(generateDefaultValue(type)).toEqual(expected);
  });

  it('returns empty array for list types', () => {
    expect(generateDefaultValue('[String]')).toEqual([]);
    expect(generateDefaultValue('[Int!]!')).toEqual([]);
  });

  it('returns empty object for unknown/custom types', () => {
    expect(generateDefaultValue('UserInput')).toEqual({});
    expect(generateDefaultValue('CustomType!')).toEqual({});
  });
});

describe('generateVariablesTemplate', () => {
  it('generates JSON template from parsed variables', () => {
    const vars = parseVariables(
      'query GetUser($id: ID!, $name: String) { user(id: $id) { name } }'
    );
    const template = generateVariablesTemplate(vars);
    const parsed = JSON.parse(template);
    expect(parsed).toHaveProperty('id', '');
    expect(parsed).toHaveProperty('name', '');
  });

  it('uses default value when provided', () => {
    const vars = parseVariables('query List($limit: Int = 20) { items(limit: $limit) { id } }');
    const template = generateVariablesTemplate(vars);
    const parsed = JSON.parse(template);
    expect(parsed).toHaveProperty('limit', 20);
  });

  it('returns empty JSON object for no variables', () => {
    expect(generateVariablesTemplate([])).toBe('{}');
  });
});

describe('extractOperationName', () => {
  it('extracts query name', () => {
    expect(extractOperationName('query GetUser { user { id } }')).toBe('GetUser');
  });

  it('extracts mutation name', () => {
    expect(
      extractOperationName('mutation CreateUser($name: String!) { createUser(name: $name) { id } }')
    ).toBe('CreateUser');
  });

  it('extracts subscription name', () => {
    expect(extractOperationName('subscription OnNewUser { userAdded { id } }')).toBe('OnNewUser');
  });

  it('returns null for anonymous operations', () => {
    expect(extractOperationName('{ user { id } }')).toBeNull();
    expect(extractOperationName('query { user { id } }')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractOperationName('')).toBeNull();
  });
});

describe('buildGraphQLRequestBody', () => {
  it('includes operationName for a named operation', () => {
    const body = buildGraphQLRequestBody('query GetUser { user { id } }', { id: 1 });
    expect(body).toEqual({
      query: 'query GetUser { user { id } }',
      variables: { id: 1 },
      operationName: 'GetUser',
    });
  });

  it('omits operationName for an anonymous operation', () => {
    const body = buildGraphQLRequestBody('{ user { id } }', {});
    expect(body).toEqual({ query: '{ user { id } }', variables: {} });
    expect('operationName' in body).toBe(false);
  });

  it('picks the first named operation in a multi-operation document', () => {
    const doc = 'query First { a } query Second { b }';
    expect(buildGraphQLRequestBody(doc, {}).operationName).toBe('First');
  });
});

describe('extractGraphQLErrors', () => {
  it('returns messages from a GraphQL error envelope (even with partial data)', () => {
    const body = JSON.stringify({
      data: { user: null },
      errors: [{ message: 'Not authorized' }, { message: 'Field missing' }],
    });
    expect(extractGraphQLErrors(body)).toEqual(['Not authorized', 'Field missing']);
  });

  it('returns [] for a successful response with no errors', () => {
    expect(extractGraphQLErrors(JSON.stringify({ data: { ok: true } }))).toEqual([]);
  });

  it('returns [] for non-JSON or non-object bodies', () => {
    expect(extractGraphQLErrors('<html>500</html>')).toEqual([]);
    expect(extractGraphQLErrors('')).toEqual([]);
    expect(extractGraphQLErrors('null')).toEqual([]);
  });

  it('falls back to a placeholder when an error has no message', () => {
    expect(extractGraphQLErrors(JSON.stringify({ errors: [{}] }))).toEqual([
      'Unknown GraphQL error',
    ]);
  });
});

describe('extractOperationType', () => {
  it('detects query', () => {
    expect(extractOperationType('query GetUser { user { id } }')).toBe('query');
  });

  it('detects mutation', () => {
    expect(extractOperationType('mutation CreateUser { createUser { id } }')).toBe('mutation');
  });

  it('detects subscription', () => {
    expect(extractOperationType('subscription OnEvent { eventAdded { id } }')).toBe('subscription');
  });

  it('returns null for shorthand query (no keyword)', () => {
    expect(extractOperationType('{ user { id } }')).toBeNull();
  });

  it('handles leading whitespace', () => {
    expect(extractOperationType('  \n  query GetUser { user { id } }')).toBe('query');
  });

  it('returns null for empty string', () => {
    expect(extractOperationType('')).toBeNull();
  });
});

describe('validateGraphQLSyntax', () => {
  it('returns valid for empty query', () => {
    expect(validateGraphQLSyntax('')).toEqual({ valid: true });
    expect(validateGraphQLSyntax('   ')).toEqual({ valid: true });
  });

  it('returns valid for balanced query', () => {
    expect(validateGraphQLSyntax('query { user { id name } }')).toEqual({ valid: true });
  });

  it('detects unbalanced curly braces', () => {
    const result = validateGraphQLSyntax('query { user { id }');
    expect(result.valid).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('detects extra closing brace', () => {
    const result = validateGraphQLSyntax('query { user { id } }}');
    expect(result.valid).toBe(false);
  });

  it('detects unbalanced parentheses', () => {
    const result = validateGraphQLSyntax('query GetUser($id: ID! { user(id: $id) { name } }');
    expect(result.valid).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('detects unbalanced square brackets', () => {
    const result = validateGraphQLSyntax('query { items(filter: [a) { id } }');
    expect(result.valid).toBe(false);
  });
});
