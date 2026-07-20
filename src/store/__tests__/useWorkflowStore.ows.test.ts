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
});
