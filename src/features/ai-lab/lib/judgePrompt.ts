// LLM-as-judge for AI Lab. Thin adapter over the backend-agnostic engine in
// @shared/protocol/ai/judge — the single source of truth for prompt-building
// and verdict-parsing. This module only maps the ai-lab DatasetCase shape onto
// the generic input; all behaviour lives in shared.
import {
  buildJudgeMessages as buildJudgeMessagesShared,
  JUDGE_TOOL,
  parseJudgment,
} from '@shared/protocol/ai/judge';
import type { DatasetCase } from '../types';
import type { ChatMessage } from './llmClient';

export { JUDGE_TOOL, parseJudgment };

// ChatMessageWire and ai-lab's ChatMessage are structurally identical
// ({ role; content }), so the shared result is returned directly.
export function buildJudgeMessages(args: {
  rubric: string;
  output: string;
  testCase: DatasetCase;
  passThreshold: number;
}): ChatMessage[] {
  return buildJudgeMessagesShared({
    rubric: args.rubric,
    output: args.output,
    ...(args.testCase.reference !== undefined ? { reference: args.testCase.reference } : {}),
    vars: args.testCase.vars,
    passThreshold: args.passThreshold,
  });
}
