import { AgentSuiteSchema, type AgentSuite, type AgentSuiteReport } from '@shared/agent-lab';
import { z } from 'zod';
import type { EvalRun } from '../types';
import type { RunStatus } from './types';

interface ReportBase {
  id: string;
  name: string;
  startedAt: number;
  finishedAt: number;
  status: RunStatus;
}

export type AiLabReportEnvelope =
  | (ReportBase & {
      kind: 'eval';
      payload: EvalRun;
    })
  | (ReportBase & {
      kind: 'agent-suite';
      payload: AgentSuiteReport;
      /** Immutable task/input/reference snapshot used to interpret the report. */
      suite: AgentSuite;
    });

const ReportBaseSchema = z.object({
  id: z.string(),
  name: z.string(),
  startedAt: z.number(),
  finishedAt: z.number(),
  status: z.enum(['queued', 'running', 'cancelling', 'passed', 'failed', 'error', 'cancelled']),
});

export const AiLabReportEnvelopeSchema: z.ZodType<AiLabReportEnvelope> = z.discriminatedUnion(
  'kind',
  [
    ReportBaseSchema.extend({ kind: z.literal('eval'), payload: z.custom<EvalRun>() }),
    ReportBaseSchema.extend({
      kind: z.literal('agent-suite'),
      payload: z.custom<AgentSuiteReport>(),
      suite: AgentSuiteSchema,
    }),
  ]
);

export function adaptEvalRunReport(run: EvalRun): AiLabReportEnvelope {
  return {
    id: run.id,
    kind: 'eval',
    name: run.configName,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt ?? run.startedAt,
    status: evalStatus(run.status),
    payload: run,
  };
}

export function createAgentSuiteReportEnvelope(
  suite: AgentSuite,
  report: AgentSuiteReport,
  timing: { id: string; startedAt: number; finishedAt: number }
): AiLabReportEnvelope {
  return {
    ...timing,
    kind: 'agent-suite',
    name: suite.name,
    status: report.status,
    payload: report,
    suite: structuredClone(suite),
  };
}

function evalStatus(status: EvalRun['status']): RunStatus {
  if (status === 'done') return 'passed';
  if (status === 'running') return 'running';
  return status;
}
