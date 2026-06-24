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
 */
import { validateWorkflowGraph } from './flowValidators';
import type { WorkflowGraph } from '@/types';

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
  return { ok: true, graph: res.graph };
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
