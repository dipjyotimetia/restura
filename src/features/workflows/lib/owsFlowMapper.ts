import type { OwsBindings, OwsLayout, OwsTaskBinding } from '@shared/ows/bindings';
import type { OwsWorkflow } from '@shared/ows/workflow-profile';

export type WorkflowBlockKind = 'do' | 'set' | 'wait' | 'call';

export interface WorkflowBlock {
  /** Stable only for the current editor draft; task paths are regenerated on save. */
  id: string;
  name: string;
  kind: WorkflowBlockKind;
  position: { x: number; y: number };
  timeout?: unknown;
  set?: Record<string, unknown>;
  wait?: Record<string, number>;
  method?: string;
  binding?: OwsTaskBinding;
  children?: WorkflowBlock[];
}

export interface WorkflowFlowModel {
  blocks: WorkflowBlock[];
  /** Preserved even though the graph editor does not edit workflow-wide deadlines yet. */
  timeout?: unknown;
  viewport?: OwsLayout['viewport'];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function blocksFromTasks(
  tasks: unknown,
  path: string,
  bindings: OwsBindings,
  layout: OwsLayout
): WorkflowBlock[] {
  if (!Array.isArray(tasks)) return [];
  const blocks: WorkflowBlock[] = [];
  for (const [index, entry] of tasks.entries()) {
    if (!isRecord(entry) || Object.keys(entry).length !== 1) return [];
    const [name, task] = Object.entries(entry)[0] ?? [];
    if (!name || !isRecord(task)) continue;
    const taskPath = `${path}/${index}/${name}`;
    const position = layout.nodes[taskPath] ?? { x: 0, y: index * 140 };
    const timeout = task.timeout === undefined ? undefined : clone(task.timeout);
    if ('do' in task) {
      blocks.push({
        id: taskPath,
        name,
        kind: 'do',
        position,
        ...(timeout ? { timeout } : {}),
        children: blocksFromTasks(task.do, `${taskPath}/do`, bindings, layout),
      });
      continue;
    }
    if ('set' in task && isRecord(task.set)) {
      blocks.push({
        id: taskPath,
        name,
        kind: 'set',
        position,
        ...(timeout ? { timeout } : {}),
        set: clone(task.set),
      });
      continue;
    }
    if ('wait' in task && isRecord(task.wait)) {
      blocks.push({
        id: taskPath,
        name,
        kind: 'wait',
        position,
        ...(timeout ? { timeout } : {}),
        wait: clone(task.wait) as Record<string, number>,
      });
      continue;
    }
    if ('call' in task && isRecord(task.with) && typeof task.with.method === 'string') {
      const binding = bindings.tasks[taskPath];
      blocks.push({
        id: taskPath,
        name,
        kind: 'call',
        position,
        ...(timeout ? { timeout } : {}),
        method: task.with.method,
        ...(binding ? { binding: clone(binding) } : {}),
      });
    }
  }
  return blocks;
}

export function deriveOwsFlowModel(
  document: OwsWorkflow,
  bindings: OwsBindings,
  layout: OwsLayout
): WorkflowFlowModel {
  return {
    blocks: blocksFromTasks(document.do, '/do', bindings, layout),
    ...(document.timeout === undefined ? {} : { timeout: clone(document.timeout) }),
    ...(layout.viewport ? { viewport: layout.viewport } : {}),
  };
}

function tasksFromBlocks(
  blocks: WorkflowBlock[],
  path: string,
  bindings: OwsBindings,
  layout: OwsLayout
): Array<Record<string, unknown>> {
  return blocks.map((block, index) => {
    const taskPath = `${path}/${index}/${block.name}`;
    layout.nodes[taskPath] = block.position;
    const timeout = block.timeout === undefined ? {} : { timeout: clone(block.timeout) };
    let task: Record<string, unknown>;
    if (block.kind === 'do')
      task = {
        do: tasksFromBlocks(block.children ?? [], `${taskPath}/do`, bindings, layout),
        ...timeout,
      };
    else if (block.kind === 'set') task = { set: clone(block.set ?? {}), ...timeout };
    else if (block.kind === 'wait')
      task = { wait: clone(block.wait ?? { milliseconds: 0 }), ...timeout };
    else {
      if (!block.binding || !block.method)
        throw new Error(`Saved HTTP block '${block.name}' needs a bound request.`);
      bindings.tasks[taskPath] = clone(block.binding);
      task = {
        call: 'http',
        with: { method: block.method, endpoint: { uri: 'restura://saved-request' } },
        ...timeout,
      };
    }
    return { [block.name]: task };
  });
}

export function serializeOwsFlowModel(
  model: WorkflowFlowModel,
  metadata: OwsWorkflow['document']
): { document: OwsWorkflow; bindings: OwsBindings; layout: OwsLayout } {
  const bindings: OwsBindings = { version: 1, tasks: {} };
  const layout: OwsLayout = {
    version: 1,
    nodes: {},
    ...(model.viewport ? { viewport: model.viewport } : {}),
  };
  return {
    document: {
      document: clone(metadata),
      ...(model.timeout === undefined ? {} : { timeout: clone(model.timeout) }),
      do: tasksFromBlocks(model.blocks, '/do', bindings, layout),
    } as OwsWorkflow,
    bindings,
    layout,
  };
}
