import type { OwsBindings, OwsLayout, OwsTaskBinding } from '@shared/ows/bindings';
import type { OwsWorkflow } from '@shared/ows/workflow-profile';

export type WorkflowBlockKind = 'do' | 'for' | 'set' | 'try' | 'wait' | 'call';

export interface WorkflowBlock {
  /** Stable only for the current editor draft; task paths are regenerated on save. */
  id: string;
  name: string;
  kind: WorkflowBlockKind;
  position: { x: number; y: number };
  timeout?: unknown;
  condition?: string;
  set?: Record<string, unknown>;
  wait?: Record<string, number>;
  for?: { each: string; in: string; at?: string };
  catchAs?: string;
  method?: string;
  binding?: OwsTaskBinding;
  children?: WorkflowBlock[];
  catchChildren?: WorkflowBlock[];
}

export interface WorkflowFlowModel {
  blocks: WorkflowBlock[];
  /** Preserved even though the graph editor does not edit workflow-wide deadlines yet. */
  timeout?: unknown;
  output?: unknown;
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
    const position = layout.nodes[taskPath] ?? { x: 260, y: index * 140 + 100 };
    const timeout = task.timeout === undefined ? undefined : clone(task.timeout);
    const condition = typeof task.if === 'string' ? task.if : undefined;
    const common = {
      ...(timeout === undefined ? {} : { timeout }),
      ...(condition === undefined ? {} : { condition }),
    };
    if ('for' in task && isRecord(task.for)) {
      const config = task.for;
      if (typeof config.each !== 'string' || typeof config.in !== 'string') continue;
      blocks.push({
        id: taskPath,
        name,
        kind: 'for',
        position,
        ...common,
        for: {
          each: config.each,
          in: config.in,
          ...(typeof config.at === 'string' ? { at: config.at } : {}),
        },
        children: blocksFromTasks(task.do, `${taskPath}/do`, bindings, layout),
      });
      continue;
    }
    if ('try' in task) {
      const catchConfig = isRecord(task.catch) ? task.catch : undefined;
      blocks.push({
        id: taskPath,
        name,
        kind: 'try',
        position,
        ...common,
        children: blocksFromTasks(task.try, `${taskPath}/try`, bindings, layout),
        ...(typeof catchConfig?.as === 'string' ? { catchAs: catchConfig.as } : {}),
        ...(catchConfig && 'do' in catchConfig
          ? {
              catchChildren: blocksFromTasks(
                catchConfig.do,
                `${taskPath}/catch/do`,
                bindings,
                layout
              ),
            }
          : {}),
      });
      continue;
    }
    if ('do' in task) {
      blocks.push({
        id: taskPath,
        name,
        kind: 'do',
        position,
        ...common,
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
        ...common,
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
        ...common,
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
        ...common,
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
    ...(document.output === undefined ? {} : { output: clone(document.output) }),
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
    const condition = block.condition === undefined ? {} : { if: block.condition };
    let task: Record<string, unknown>;
    if (block.kind === 'do')
      task = {
        do: tasksFromBlocks(block.children ?? [], `${taskPath}/do`, bindings, layout),
        ...timeout,
        ...condition,
      };
    else if (block.kind === 'for') {
      task = {
        for: clone(block.for ?? { each: 'item', in: '${.items}' }),
        do: tasksFromBlocks(block.children ?? [], `${taskPath}/do`, bindings, layout),
        ...timeout,
        ...condition,
      };
    } else if (block.kind === 'try') {
      const catchChildren = block.catchChildren ?? [];
      task = {
        try: tasksFromBlocks(block.children ?? [], `${taskPath}/try`, bindings, layout),
        ...(catchChildren.length > 0
          ? {
              catch: {
                ...(block.catchAs ? { as: block.catchAs } : {}),
                do: tasksFromBlocks(catchChildren, `${taskPath}/catch/do`, bindings, layout),
              },
            }
          : {}),
        ...timeout,
        ...condition,
      };
    } else if (block.kind === 'set')
      task = { set: clone(block.set ?? {}), ...timeout, ...condition };
    else if (block.kind === 'wait')
      task = { wait: clone(block.wait ?? { milliseconds: 0 }), ...timeout, ...condition };
    else {
      if (!block.binding || !block.method)
        throw new Error(`Saved HTTP block '${block.name}' needs a bound request.`);
      bindings.tasks[taskPath] = clone(block.binding);
      task = {
        call: 'http',
        with: { method: block.method, endpoint: { uri: 'restura://saved-request' } },
        ...timeout,
        ...condition,
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
      ...(model.output === undefined ? {} : { output: clone(model.output) }),
      do: tasksFromBlocks(model.blocks, '/do', bindings, layout),
    } as OwsWorkflow,
    bindings,
    layout,
  };
}
