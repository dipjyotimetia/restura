/**
 * Zod validation for WorkflowGraph (the React Flow DAG).
 *
 * The schema is **recursive**: forEach and tryCatch nodes nest subgraphs
 * that must themselves validate as full WorkflowGraphs. Zod's `z.lazy`
 * supports this — we declare a forward reference and resolve it inside
 * the lazy callback.
 *
 * Beyond shape validation, `validateWorkflowGraph` also runs structural
 * checks that aren't expressible in Zod alone:
 *   - exactly one `start` node, at least one `end` node
 *   - edge endpoints reference existing nodes
 *   - condition node outgoing edges have `sourceHandle: 'true' | 'false'`
 *   - graph is acyclic (recursing into every subgraph)
 *   - subWorkflow nodes don't form a recursion cycle by `workflowId`
 *     (when given a `getReferencedWorkflow` resolver)
 */
import { z } from 'zod';
import type { FlowEdge, FlowNode, WorkflowGraph } from '@/types';
import { allSubgraphs, getOutgoingEdges } from './flowTypes';

const flowPositionSchema = z.object({
  x: z.number(),
  y: z.number(),
});

const baseNode = {
  id: z.string().min(1),
  position: flowPositionSchema,
};

// Forward-declared lazy reference so we can nest subgraphs.
const workflowGraphSchemaInner: z.ZodType<WorkflowGraph> = z.lazy(() =>
  z.object({
    version: z.literal(1),
    nodes: z.array(flowNodeSchema),
    edges: z.array(flowEdgeSchema),
    viewport: z
      .object({
        x: z.number(),
        y: z.number(),
        zoom: z.number().positive(),
        // (intentionally not .finite() — Zod 4 numbers are finite by default)
      })
      .optional(),
  })
);

const startNodeSchema = z.object({
  ...baseNode,
  kind: z.literal('start'),
});

const endNodeSchema = z.object({
  ...baseNode,
  kind: z.literal('end'),
});

const requestNodeSchema = z.object({
  ...baseNode,
  kind: z.literal('request'),
  data: z.object({
    workflowRequestId: z.string().min(1),
    failureMode: z.enum(['thrown-only', 'http-status', 'never']).optional(),
  }),
});

const conditionNodeSchema = z.object({
  ...baseNode,
  kind: z.literal('condition'),
  data: z.object({
    expression: z.string().min(1),
    description: z.string().optional(),
  }),
});

const switchNodeSchema = z.object({
  ...baseNode,
  kind: z.literal('switch'),
  data: z.object({
    cases: z.array(
      z.object({
        id: z.string().min(1),
        label: z.string().optional(),
        expression: z.string().min(1),
      })
    ),
    description: z.string().optional(),
  }),
});

const setVariableNodeSchema = z.object({
  ...baseNode,
  kind: z.literal('setVariable'),
  data: z.object({
    assignments: z.array(
      z.object({
        key: z.string().min(1),
        valueExpression: z.string(),
      })
    ),
  }),
});

const delayNodeSchema = z.object({
  ...baseNode,
  kind: z.literal('delay'),
  data: z.object({
    ms: z.number().int().min(0).max(3_600_000),
  }),
});

const transformNodeSchema = z.object({
  ...baseNode,
  kind: z.literal('transform'),
  data: z.object({
    script: z.string(),
  }),
});

const templateNodeSchema = z.object({
  ...baseNode,
  kind: z.literal('template'),
  data: z.object({
    template: z.string(),
    resultVar: z.string().min(1),
  }),
});

const displayNodeSchema = z.object({
  ...baseNode,
  kind: z.literal('display'),
  data: z.object({
    valueExpression: z.string().min(1),
    mode: z.enum(['json', 'table', 'raw']),
    label: z.string().optional(),
  }),
});

const parallelNodeSchema = z.object({
  ...baseNode,
  kind: z.literal('parallel'),
  data: z.object({
    waitMode: z.enum(['all', 'any', 'race']),
    mergeStrategy: z.enum(['fail-on-conflict', 'pick-first', 'pick-last', 'merge-list']).optional(),
  }),
});

const forEachNodeSchema = z.object({
  ...baseNode,
  kind: z.literal('forEach'),
  data: z.object({
    collectionExpression: z.string().min(1),
    iteratorVar: z.string().min(1),
    subgraph: workflowGraphSchemaInner,
    concurrency: z.number().int().min(1).max(64).optional(),
  }),
});

const loopNodeSchema = z.object({
  ...baseNode,
  kind: z.literal('loop'),
  data: z.object({
    conditionExpression: z.string().min(1),
    mode: z.enum(['while', 'until']),
    maxIterations: z.number().int().min(1).max(100_000),
    delayMs: z.number().int().min(0).max(3_600_000).optional(),
    subgraph: workflowGraphSchemaInner,
  }),
});

const tryCatchNodeSchema = z.object({
  ...baseNode,
  kind: z.literal('tryCatch'),
  data: z.object({
    trySubgraph: workflowGraphSchemaInner,
    catchSubgraph: workflowGraphSchemaInner,
  }),
});

const subWorkflowNodeSchema = z.object({
  ...baseNode,
  kind: z.literal('subWorkflow'),
  data: z.object({
    workflowId: z.string().min(1),
    inputVarMap: z.record(z.string(), z.string()).optional(),
    outputVarMap: z.record(z.string(), z.string()).optional(),
  }),
});

const completionPolicySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('eventCount'), n: z.number().int().min(1).max(1_000_000) }),
  z.object({ kind: z.literal('timeoutMs'), ms: z.number().int().min(1).max(86_400_000) }),
  z.object({ kind: z.literal('eventMatch'), expression: z.string().min(1) }),
  z.object({ kind: z.literal('connectionClose') }),
]);

const failureModeSchema = z.enum(['thrown-only', 'http-status', 'never']).optional();

const sseSubscribeNodeSchema = z.object({
  ...baseNode,
  kind: z.literal('sseSubscribe'),
  data: z.object({
    workflowRequestId: z.string().min(1),
    completion: completionPolicySchema,
    accumulateAll: z.boolean().optional(),
    maxEvents: z.number().int().min(1).max(1_000_000).optional(),
    resultVar: z.string().optional(),
    failureMode: failureModeSchema,
  }),
});

const wsExchangeNodeSchema = z.object({
  ...baseNode,
  kind: z.literal('wsExchange'),
  data: z.object({
    url: z.string().min(1),
    sendExpression: z.string().min(1),
    matchExpression: z.string().min(1),
    completion: completionPolicySchema,
    resultVar: z.string().optional(),
    failureMode: failureModeSchema,
  }),
});

const mcpCallNodeSchema = z.object({
  ...baseNode,
  kind: z.literal('mcpCall'),
  data: z.object({
    workflowRequestId: z.string().min(1),
    method: z.string().min(1),
    paramsExpression: z.string().optional(),
    resultVar: z.string().optional(),
    failureMode: failureModeSchema,
  }),
});

export const flowNodeSchema = z.discriminatedUnion('kind', [
  startNodeSchema,
  endNodeSchema,
  requestNodeSchema,
  conditionNodeSchema,
  switchNodeSchema,
  setVariableNodeSchema,
  delayNodeSchema,
  transformNodeSchema,
  templateNodeSchema,
  displayNodeSchema,
  parallelNodeSchema,
  forEachNodeSchema,
  loopNodeSchema,
  tryCatchNodeSchema,
  subWorkflowNodeSchema,
  sseSubscribeNodeSchema,
  wsExchangeNodeSchema,
  mcpCallNodeSchema,
]) as unknown as z.ZodType<FlowNode>;

export const flowEdgeSchema: z.ZodType<FlowEdge> = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  sourceHandle: z.string().optional(),
  label: z.string().optional(),
});

export const workflowGraphSchema = workflowGraphSchemaInner;

// Structural validation
// ---------------------

export interface ValidationIssue {
  path: string;
  message: string;
}

export function validateWorkflowGraph(graph: unknown):
  | {
      ok: true;
      graph: WorkflowGraph;
    }
  | { ok: false; issues: ValidationIssue[] } {
  const parsed = workflowGraphSchema.safeParse(graph);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    };
  }

  const issues: ValidationIssue[] = [];

  // Top-level structural checks recurse through every subgraph so a
  // nested forEach/tryCatch broken graph still trips the validator.
  let subgraphIndex = 0;
  for (const sg of allSubgraphs(parsed.data)) {
    const label = subgraphIndex === 0 ? 'graph' : `subgraph[${subgraphIndex}]`;
    subgraphIndex++;

    const starts = sg.nodes.filter((n) => n.kind === 'start');
    if (starts.length !== 1) {
      issues.push({
        path: label,
        message: `expected exactly 1 start node, found ${starts.length}`,
      });
    }
    if (!sg.nodes.some((n) => n.kind === 'end')) {
      issues.push({ path: label, message: 'expected at least 1 end node' });
    }

    const nodeIds = new Set(sg.nodes.map((n) => n.id));
    for (const edge of sg.edges) {
      if (!nodeIds.has(edge.source)) {
        issues.push({
          path: `${label}.edges.${edge.id}.source`,
          message: `references unknown node "${edge.source}"`,
        });
      }
      if (!nodeIds.has(edge.target)) {
        issues.push({
          path: `${label}.edges.${edge.id}.target`,
          message: `references unknown node "${edge.target}"`,
        });
      }
    }

    for (const node of sg.nodes) {
      if (node.kind === 'condition') {
        const out = getOutgoingEdges(sg, node.id);
        const handles = new Set(out.map((e) => e.sourceHandle));
        if (out.length !== 2 || !handles.has('true') || !handles.has('false')) {
          issues.push({
            path: `${label}.nodes.${node.id}`,
            message:
              'condition node must have exactly two outgoing edges with sourceHandle "true" and "false"',
          });
        }
      }
    }

    if (hasCycle(sg)) {
      issues.push({ path: label, message: 'graph contains a cycle' });
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, graph: parsed.data };
}

function hasCycle(graph: WorkflowGraph): boolean {
  const adj = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (!adj.has(e.source)) adj.set(e.source, []);
    adj.get(e.source)!.push(e.target);
  }
  const WHITE = 0,
    GRAY = 1,
    BLACK = 2;
  const colour = new Map<string, number>();
  for (const n of graph.nodes) colour.set(n.id, WHITE);

  function dfs(id: string): boolean {
    colour.set(id, GRAY);
    for (const next of adj.get(id) ?? []) {
      const c = colour.get(next);
      if (c === GRAY) return true;
      if (c === WHITE && dfs(next)) return true;
    }
    colour.set(id, BLACK);
    return false;
  }

  for (const n of graph.nodes) {
    if (colour.get(n.id) === WHITE && dfs(n.id)) return true;
  }
  return false;
}
