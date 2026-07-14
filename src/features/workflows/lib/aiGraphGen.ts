/**
 * Pure core for AI-assisted workflow generation. The transport (Electron
 * AI streaming) lives elsewhere; this module is decoupled and unit-tested:
 *
 *   - `buildGraphSystemPrompt()` describes the WorkflowGraph JSON contract
 *     and the node-kind catalogue for the model.
 *   - `extractGraphFromAiText()` pulls a JSON object out of a (possibly
 *     fenced, possibly prose-wrapped) model response and validates it
 *     through the same Zod gate the store uses.
 *
 * Keeping this pure means the correctness-critical part (prompt + parse +
 * validate) is testable without an Electron harness or a live model.
 *
 * **Not wired up yet.** No UI, hook, store action, or Electron handler
 * currently calls `buildGraphSystemPrompt`/`extractGraphFromAiText` —
 * there is no "generate a workflow from a prompt" entry point in the app
 * today. Whoever wires this up next should route the extracted graph
 * through `remapGraphIds` (already applied on the success path here) if
 * they ever merge/insert it into an EXISTING graph rather than creating a
 * brand-new workflow, and confirm the transport layer applies the same
 * SSRF/validation guarantees to AI-sourced content as human-authored edits.
 */
import { v4 as uuidv4 } from 'uuid';
import type { FlowNode, WorkflowGraph } from '@/types';
import { validateWorkflowGraph } from './flowValidators';

/**
 * System prompt that constrains the model to emit a single WorkflowGraph
 * JSON object. Mirrors the canonical FlowNode shapes in `src/types`.
 */
export function buildGraphSystemPrompt(): string {
  return [
    'You generate workflow graphs for Restura, a multi-protocol API client.',
    'Return ONLY a single JSON object — no prose, no markdown fences — matching:',
    '{ "version": 1, "nodes": FlowNode[], "edges": FlowEdge[] }',
    '',
    'Rules:',
    '- Exactly one node with "kind":"start" and at least one with "kind":"end".',
    '- Every node: { "id": string, "kind": string, "position": {"x":number,"y":number}, "data"?: object }.',
    '- start/end nodes have no "data".',
    '- Edges: { "id": string, "source": nodeId, "target": nodeId, "sourceHandle"?: string }.',
    '- The graph must be acyclic. Connect start → … → end.',
    '',
    'Node kinds and their "data":',
    '- request: { workflowRequestId: string } — references a saved request (leave a placeholder id if unknown).',
    '- condition: { expression: string } — JS returning boolean; two out-edges with sourceHandle "true" and "false".',
    '- switch: { cases: [{ id, label?, expression }] } — out-edges use sourceHandle = case id, plus one "default".',
    '- setVariable: { assignments: [{ key, valueExpression }] } — valueExpression is JS.',
    '- delay: { ms: number }.',
    '- transform: { script: string } — JS using pm.variables.get/set.',
    '- template: { template: string, resultVar: string } — {{var}} interpolation into resultVar.',
    '- display: { valueExpression: string, mode: "json"|"table"|"raw", label? } — show a value.',
    '- parallel: { waitMode: "all"|"any"|"race", mergeStrategy?: "fail-on-conflict"|"pick-first"|"pick-last"|"merge-list" }.',
    '- forEach: { collectionExpression: string, iteratorVar: string, subgraph: WorkflowGraph, concurrency? }.',
    '- loop: { conditionExpression: string, mode: "while"|"until", maxIterations: number, delayMs?, subgraph: WorkflowGraph }.',
    '- tryCatch: { trySubgraph: WorkflowGraph, catchSubgraph: WorkflowGraph }.',
    '- subWorkflow: { workflowId: string, inputVarMap?, outputVarMap? }.',
    '',
    'Nested subgraphs (forEach/loop/tryCatch) are themselves { version:1, nodes, edges } with their own start/end.',
  ].join('\n');
}

export type GraphExtractResult = { ok: true; graph: WorkflowGraph } | { ok: false; error: string };

/**
 * Pull the first JSON object out of a model response and validate it as a
 * WorkflowGraph. Tolerates ```json fences and surrounding prose.
 */
export function extractGraphFromAiText(text: string): GraphExtractResult {
  const jsonText = extractJsonBlock(text);
  if (jsonText === null) {
    return { ok: false, error: 'No JSON object found in the response.' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { ok: false, error: 'Response contained malformed JSON.' };
  }
  const res = validateWorkflowGraph(parsed);
  if (!res.ok) {
    const first = res.issues[0];
    return {
      ok: false,
      error: `Generated graph is invalid${first ? `: ${first.path} — ${first.message}` : ''}`,
    };
  }
  return { ok: true, graph: remapGraphIds(res.graph) };
}

/**
 * Replace every node/edge id in the graph (recursively through nested
 * forEach/loop/tryCatch subgraphs) with a fresh uuid. The model emits its
 * own ids verbatim (often short/predictable, e.g. "start", "sv", "end" —
 * see the test fixtures), and nothing else in the pipeline remaps them.
 * Rewriting here means a generated graph is safe to merge into an
 * existing one without id collisions, whether or not a merge path exists
 * yet — id namespacing is cheap to guarantee now and expensive to retrofit
 * once something depends on the model's ids being stable.
 */
function remapGraphIds(graph: WorkflowGraph): WorkflowGraph {
  const idMap = new Map<string, string>();

  const remapNode = (node: FlowNode): FlowNode => {
    const newId = uuidv4();
    idMap.set(node.id, newId);
    if (node.kind === 'forEach') {
      return {
        ...node,
        id: newId,
        data: { ...node.data, subgraph: remapGraphIds(node.data.subgraph) },
      };
    }
    if (node.kind === 'loop') {
      return {
        ...node,
        id: newId,
        data: { ...node.data, subgraph: remapGraphIds(node.data.subgraph) },
      };
    }
    if (node.kind === 'tryCatch') {
      return {
        ...node,
        id: newId,
        data: {
          ...node.data,
          trySubgraph: remapGraphIds(node.data.trySubgraph),
          catchSubgraph: remapGraphIds(node.data.catchSubgraph),
        },
      };
    }
    return { ...node, id: newId } as FlowNode;
  };

  const nodes = graph.nodes.map(remapNode);
  // Edges are processed after all nodes so `idMap` is fully populated —
  // `source`/`target` reference sibling nodes at this same graph level.
  const edges = graph.edges.map((e) => ({
    ...e,
    id: uuidv4(),
    source: idMap.get(e.source) ?? e.source,
    target: idMap.get(e.target) ?? e.target,
  }));

  return { ...graph, nodes, edges };
}

/** Extract a JSON object string: prefer a fenced block, else the first
 *  balanced {...} span. Returns null when nothing object-like is present. */
function extractJsonBlock(text: string): string | null {
  const trimmed = text.trim();

  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fence?.[1]?.trim() ?? trimmed;

  const start = candidate.indexOf('{');
  if (start === -1) return null;

  // Walk to the matching close brace, respecting strings/escapes.
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return candidate.slice(start, i + 1);
    }
  }
  return null;
}
