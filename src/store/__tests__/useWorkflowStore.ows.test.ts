import { beforeEach, describe, expect, it } from 'vitest';
import { useWorkflowStore } from '../useWorkflowStore';

describe('useWorkflowStore OWS workflows', () => {
  beforeEach(() => {
    useWorkflowStore.setState({ workflows: [] });
  });

  it('creates an OWS-native workflow with empty, non-semantic artifacts', () => {
    const workflow = useWorkflowStore.getState().createNewWorkflow('My Flow', 'collection-1');

    expect(workflow).toMatchObject({
      collectionId: 'collection-1',
      document: {
        document: { dsl: '1.0.3', namespace: 'restura', name: 'my-flow' },
        do: [{ initialize: { wait: { milliseconds: 0 } } }],
      },
      bindings: { version: 1, tasks: {} },
      layout: { version: 1, nodes: {} },
    });
  });

  it('fails closed when updating OWS artifacts with a stale task-path binding', () => {
    const workflow = useWorkflowStore.getState().createNewWorkflow('My Flow', 'collection-1');
    useWorkflowStore.getState().addWorkflow(workflow);

    expect(() =>
      useWorkflowStore.getState().updateWorkflowArtifacts(
        workflow.id,
        workflow.document,
        {
          version: 1,
          tasks: {
            '/do/9/missing': { kind: 'saved-request', call: 'http', resourceId: 'request-1' },
          },
        },
        workflow.layout
      )
    ).toThrow('does not exist');
  });

  it('keeps bindings for calls nested in a recovery path', () => {
    const workflow = useWorkflowStore.getState().createNewWorkflow('Recovery', 'collection-1');
    useWorkflowStore.getState().addWorkflow(workflow);
    const document = {
      ...workflow.document,
      do: [
        {
          recover: {
            try: [
              {
                request: {
                  call: 'http',
                  with: { method: 'GET', endpoint: { uri: 'restura://saved-request' } },
                },
              },
            ],
            catch: { as: 'error', do: [{ fallback: { wait: { milliseconds: 0 } } }] },
          },
        },
      ],
    };
    const bindings = {
      version: 1 as const,
      tasks: {
        '/do/0/recover/try/0/request': {
          kind: 'saved-request' as const,
          call: 'http' as const,
          resourceId: 'request-1',
        },
      },
    };

    expect(() =>
      useWorkflowStore
        .getState()
        .updateWorkflowArtifacts(workflow.id, document, bindings, workflow.layout)
    ).not.toThrow();
  });

  it('renames, scopes, and removes only complete workflow artifacts', () => {
    const first = useWorkflowStore.getState().createNewWorkflow('First workflow', 'collection-1');
    const second = useWorkflowStore.getState().createNewWorkflow('Second workflow', 'collection-2');
    useWorkflowStore.getState().addWorkflow(first);
    useWorkflowStore.getState().addWorkflow(second);

    useWorkflowStore.getState().renameWorkflow(first.id, '  Release candidate!  ');

    expect(useWorkflowStore.getState().getWorkflowById(first.id)?.document.document.name).toBe(
      'release-candidate'
    );
    expect(useWorkflowStore.getState().getWorkflowsByCollectionId('collection-1')).toHaveLength(1);
    expect(useWorkflowStore.getState().getWorkflowById('missing')).toBeUndefined();

    useWorkflowStore.getState().removeWorkflowsByCollectionId('collection-1');
    expect(useWorkflowStore.getState().workflows.map((workflow) => workflow.id)).toEqual([
      second.id,
    ]);
    useWorkflowStore.getState().removeWorkflow(second.id);
    expect(useWorkflowStore.getState().workflows).toEqual([]);
  });

  it('rejects malformed non-semantic layout data before persisting a workflow', () => {
    const workflow = useWorkflowStore.getState().createNewWorkflow('Safe flow', 'collection-1');

    expect(() =>
      useWorkflowStore.getState().addWorkflow({
        ...workflow,
        layout: { version: 1, nodes: { '/do/0/initialize': { x: Number.NaN, y: 0 } } },
      })
    ).toThrow('Invalid workflow artifact.');
    expect(useWorkflowStore.getState().workflows).toEqual([]);
  });
});
