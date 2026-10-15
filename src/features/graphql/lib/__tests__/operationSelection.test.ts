import { describe, expect, it } from 'vitest';
import type { RequestBody } from '@/types';
import {
  applyOperationSelection,
  isSameOperation,
  operationChipLabel,
  operationForRun,
  resolveGraphQLOperationState,
  runButtonLabel,
} from '../operationSelection';

const DOC = [
  'query GetUser($id: ID!) { user(id: $id) { id } }',
  'mutation Rename($id: ID!, $name: String!) { rename(id: $id, name: $name) { id } }',
  'subscription OnUser { userChanged { id } }',
].join('\n');

describe('resolveGraphQLOperationState', () => {
  it('selects the stored operation and derives transport from its AST type', () => {
    const state = resolveGraphQLOperationState(DOC, 'OnUser');
    expect(state.operations.map((o) => o.name)).toEqual(['GetUser', 'Rename', 'OnUser']);
    expect(state.selected?.name).toBe('OnUser');
    expect(state.operationType).toBe('subscription');
    expect(state.isSubscription).toBe(true);
    expect(state.operationName).toBe('OnUser');
  });

  it('defaults to the first operation when nothing valid is stored', () => {
    const state = resolveGraphQLOperationState(DOC, 'Deleted');
    expect(state.selected?.name).toBe('GetUser');
    expect(state.isSubscription).toBe(false);
  });

  it('routes a comment-first subscription to the WebSocket transport (GQL-1)', () => {
    const state = resolveGraphQLOperationState('# feed\nsubscription S { s }', undefined);
    expect(state.isSubscription).toBe(true);
  });

  it('reports no operation for an empty document', () => {
    const state = resolveGraphQLOperationState('', undefined);
    expect(state).toMatchObject({
      operations: [],
      operationType: null,
      operationName: null,
      isSubscription: false,
    });
    expect(state.selected).toBeUndefined();
  });

  it('leaves operationName null for anonymous operations', () => {
    expect(resolveGraphQLOperationState('{ a }', undefined)).toMatchObject({
      operationType: 'query',
      operationName: null,
    });
  });
});

describe('applyOperationSelection', () => {
  const ops = resolveGraphQLOperationState(DOC, undefined).operations;
  const body: RequestBody = { type: 'graphql', raw: DOC, graphqlVariables: '{"id":"7"}' };

  it('persists the selection and re-scopes variables to the operation', () => {
    const rename = ops[1]!;
    const next = applyOperationSelection(body, rename, '{"id":"7"}');
    expect(next.body).toEqual({
      ...body,
      graphqlOperationName: 'Rename',
      graphqlVariables: next.variables,
    });
    expect(JSON.parse(next.variables)).toEqual({ id: '7', name: '' });
  });

  it('keeps the variables text untouched when it is not valid JSON', () => {
    const next = applyOperationSelection(body, ops[2]!, '{ broken');
    expect(next.variables).toBe('{ broken');
    expect(next.body.graphqlVariables).toBe('{ broken');
  });

  it('clears the stored name for an anonymous operation', () => {
    const [anon] = resolveGraphQLOperationState('{ a }', undefined).operations;
    const next = applyOperationSelection({ ...body, graphqlOperationName: 'Old' }, anon!, '{}');
    expect('graphqlOperationName' in next.body).toBe(false);
    expect(next.variables).toBe('{}');
  });
});

describe('operationForRun', () => {
  const state = resolveGraphQLOperationState(DOC, 'Rename');

  it('runs the operation under the cursor', () => {
    expect(operationForRun(state, DOC.indexOf('userChanged'))?.name).toBe('OnUser');
  });

  it('falls back to the selected operation without a usable cursor', () => {
    expect(operationForRun(state)?.name).toBe('Rename');
    expect(operationForRun(state, DOC.length + 50)?.name).toBe('Rename');
  });
});

describe('isSameOperation', () => {
  it('compares by position, name and type rather than identity', () => {
    const [a, b] = resolveGraphQLOperationState(DOC, undefined).operations;
    expect(isSameOperation(a, { ...a! })).toBe(true);
    expect(isSameOperation(a, b)).toBe(false);
    expect(isSameOperation(a, undefined)).toBe(false);
  });
});

describe('labels', () => {
  it('reflects the transport on the run button', () => {
    expect(runButtonLabel('query')).toBe('Run query');
    expect(runButtonLabel(null)).toBe('Run query');
    expect(runButtonLabel('mutation')).toBe('Run mutation');
    expect(runButtonLabel('subscription')).toBe('Subscribe');
  });

  it('names anonymous operations by type', () => {
    const [anon] = resolveGraphQLOperationState('mutation { a }', undefined).operations;
    expect(operationChipLabel(anon!)).toBe('Anonymous mutation');
    expect(operationChipLabel({ ...anon!, name: 'Save' })).toBe('Save');
  });
});
