import type { OwsBindings } from '@shared/ows/bindings';
import { getGraphqlOperation } from '@shared/ows/graphql-operation';
import type { OwsWorkflow } from '@shared/ows/workflow-profile';
import type { CollectionItem, HttpRequest } from '@/types';
import { findRequestByReference } from './collectionHelpers';

export interface WorkflowGraphqlMutation {
  taskPath: string;
  name: string;
}

function visitCalls(list: unknown, path: string, callback: (taskPath: string) => void): void {
  if (!Array.isArray(list)) return;
  for (const [index, entry] of list.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const named = Object.entries(entry as Record<string, unknown>)[0];
    if (!named) continue;
    const [name, task] = named;
    if (!task || typeof task !== 'object' || Array.isArray(task)) continue;
    const value = task as Record<string, unknown>;
    const taskPath = `${path}/${index}/${name}`;
    if (value.call === 'http') callback(taskPath);
    if ('do' in value) visitCalls(value.do, `${taskPath}/do`, callback);
    if ('try' in value) visitCalls(value.try, `${taskPath}/try`, callback);
    if (value.catch && typeof value.catch === 'object' && 'do' in value.catch) {
      visitCalls((value.catch as { do?: unknown }).do, `${taskPath}/catch/do`, callback);
    }
  }
}

/** Find every saved GraphQL mutation before the runner is allowed to dispatch. */
export function findWorkflowGraphqlMutations(
  workflow: OwsWorkflow,
  bindings: OwsBindings,
  items: CollectionItem[]
): WorkflowGraphqlMutation[] {
  const mutations: WorkflowGraphqlMutation[] = [];
  visitCalls(workflow.do, '/do', (taskPath) => {
    const binding = bindings.tasks[taskPath];
    if (!binding || !('protocol' in binding) || binding.protocol !== 'graphql') return;
    const request = findRequestByReference(items, binding.resourceId);
    if (!request || request.type !== 'http') return;
    let operation;
    try {
      operation = getGraphqlOperation(request as HttpRequest);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'invalid GraphQL document';
      throw new Error(`Workflow GraphQL binding ${binding.resourceId} is invalid: ${message}`);
    }
    if (operation.kind === 'mutation') {
      mutations.push({ taskPath, name: operation.name ?? binding.resourceId });
    }
  });
  return mutations;
}
