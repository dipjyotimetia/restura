// LLM-as-judge: build the judge prompt and parse a STRUCTURED verdict. We force
// the judge to call a tool (provider JSON/tool mode, already supported by the
// shared orchestrator) rather than regex-parsing prose — a free-text score is
// brittle and easily mis-extracted.
import type { CompletionResult } from '@shared/protocol/ai/types';
import type { DatasetCase } from '../types';
import type { ChatMessage } from './llmClient';
import type { JudgeResult } from './scorers';

export const JUDGE_TOOL = {
  name: 'submit_judgment',
  description: 'Submit your structured evaluation of the candidate answer.',
  inputSchema: {
    type: 'object',
    properties: {
      score: { type: 'number', description: 'Quality from 0.0 (worst) to 1.0 (best).' },
      reasoning: { type: 'string', description: 'Brief justification for the score.' },
      pass: { type: 'boolean', description: 'Whether the answer meets the bar.' },
    },
    required: ['score', 'reasoning', 'pass'],
  },
} as const;

export function buildJudgeMessages(args: {
  rubric: string;
  output: string;
  testCase: DatasetCase;
  passThreshold: number;
}): ChatMessage[] {
  const system =
    'You are a strict, impartial evaluator of AI model outputs. Read the rubric and the ' +
    'candidate answer, then call the submit_judgment tool. Score from 0.0 to 1.0. ' +
    `Set pass=true only if the answer meets the rubric (treat score >= ${args.passThreshold} as the bar). ` +
    'Do not be swayed by confident tone; judge substance.';

  const refBlock = args.testCase.reference
    ? `\n\nReference answer:\n${args.testCase.reference}`
    : '';
  const varsBlock = Object.keys(args.testCase.vars).length
    ? `\n\nInput variables:\n${JSON.stringify(args.testCase.vars, null, 2)}`
    : '';

  const user =
    `Rubric:\n${args.rubric}` +
    varsBlock +
    refBlock +
    `\n\nCandidate answer:\n${args.output}\n\nEvaluate the candidate answer now.`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/**
 * Parse a verdict from the judge completion. Prefers the tool call; falls back
 * to JSON in the text body for providers/models that ignored the tool. Clamps
 * the score and derives `pass` from the threshold when the model omitted it.
 */
export function parseJudgment(completion: CompletionResult, passThreshold: number): JudgeResult {
  const raw =
    completion.toolCalls.find((t) => t.name === JUDGE_TOOL.name)?.input ??
    extractJson(completion.text);
  let parsed: { score?: unknown; reasoning?: unknown; pass?: unknown } = {};
  if (raw) {
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      parsed = {};
    }
  }
  const score = clamp01(typeof parsed.score === 'number' ? parsed.score : Number(parsed.score));
  const reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning : '';
  const pass = typeof parsed.pass === 'boolean' ? parsed.pass : score >= passThreshold;
  return { score, reasoning, pass };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/** Best-effort extraction of the first {...} JSON object from free text. */
function extractJson(text: string): string | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  return text.slice(start, end + 1);
}
