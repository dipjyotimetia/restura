import {
  AgentSuiteSchema,
  ContentBlockSchema,
  TraceEventSchema,
  type AgentSuite,
  type AgentSuiteReport,
} from '@shared/agent-lab';
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

const UsageSchema = z.object({
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
});
const GraderScoreSchema = z.object({
  graderId: z.string(),
  kind: z.enum([
    'exact',
    'contains',
    'regex',
    'json-schema',
    'tool',
    'trajectory',
    'latency',
    'cost',
    'judge',
  ]),
  passed: z.boolean(),
  score: z.number().optional(),
  detail: z.string().optional(),
  judgeVotes: z
    .array(
      z.object({
        providerId: z.string(),
        model: z.string(),
        label: z.string(),
        score: z.number(),
        reasoning: z.string().optional(),
      })
    )
    .optional(),
  judgeFailures: z
    .array(z.object({ providerId: z.string(), model: z.string(), error: z.string() }))
    .optional(),
  minimumQuorum: z.number().int().nonnegative().optional(),
  usage: UsageSchema.optional(),
  costUSD: z.number().nonnegative().optional(),
  resourceCalls: z
    .object({
      attempted: z.number().int().nonnegative(),
      usageKnown: z.number().int().nonnegative(),
      costKnown: z.number().int().nonnegative(),
    })
    .optional(),
});
const ReliabilitySchema = z.object({
  agentId: z.string(),
  taskId: z.string(),
  total: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  passRate: z.number(),
  confidence95: z.object({ low: z.number(), high: z.number() }),
  passAtK: z.record(z.string(), z.number()),
  passToK: z.record(z.string(), z.number()),
});
export const AgentSuiteReportSchema = z.object({
  suiteId: z.string(),
  status: z.enum(['passed', 'failed', 'error', 'cancelled']),
  results: z.array(
    z.object({
      taskId: z.string(),
      agentId: z.string(),
      trial: z.number().int().positive(),
      status: z.enum(['passed', 'failed', 'error', 'cancelled']),
      output: z.array(ContentBlockSchema),
      trace: z.object({
        id: z.string(),
        suiteId: z.string(),
        taskId: z.string(),
        trial: z.number(),
        agentId: z.string(),
        startedAt: z.number(),
        finishedAt: z.number().optional(),
        events: z.array(TraceEventSchema),
      }),
      scores: z.array(GraderScoreSchema),
      error: z.string().optional(),
    })
  ),
  summary: z.object({
    total: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
    cancelled: z.number().int().nonnegative(),
    passRate: z.number(),
    confidence95: z.object({ low: z.number(), high: z.number() }),
    passAtK: z.record(z.string(), z.number()),
    passToK: z.record(z.string(), z.number()),
    reliabilityByCase: z.array(ReliabilitySchema),
  }),
});

const EvalScoreSchema = z.object({
  scorerId: z.string(),
  kind: z.enum([
    'exact-match',
    'contains',
    'regex',
    'json-valid',
    'json-schema',
    'latency',
    'cost',
    'script',
    'judge',
    'tool-call',
    'pairwise',
  ]),
  passed: z.boolean(),
  score: z.number().optional(),
  detail: z.string().optional(),
  perCriterion: z
    .array(
      z.object({ name: z.string(), score: z.number(), pass: z.boolean(), reasoning: z.string() })
    )
    .optional(),
  variance: z.number().optional(),
});
export const EvalRunReportSchema = z.object({
  id: z.string(),
  evalConfigId: z.string(),
  configName: z.string(),
  datasetId: z.string().optional(),
  datasetName: z.string().optional(),
  modelLabels: z.record(z.string(), z.string()).optional(),
  startedAt: z.number(),
  finishedAt: z.number().optional(),
  status: z.enum(['running', 'done', 'cancelled', 'error']),
  totalCells: z.number().int().nonnegative(),
  cells: z.array(
    z.object({
      caseId: z.string(),
      modelRef: z.object({ providerConfigId: z.string(), model: z.string() }),
      output: z.string(),
      ok: z.boolean(),
      error: z.string().optional(),
      latencyMs: z.number(),
      usage: z.object({ promptTokens: z.number(), completionTokens: z.number() }).optional(),
      cost: z.number().nullable(),
      scores: z.array(EvalScoreSchema),
      passed: z.boolean(),
      notEvaluated: z.boolean().optional(),
      executed: z
        .object({
          status: z.number(),
          latencyMs: z.number(),
          bodyExcerpt: z.string(),
          ok: z.boolean(),
        })
        .optional(),
    })
  ),
});

export const AiLabReportEnvelopeSchema = z.discriminatedUnion('kind', [
  ReportBaseSchema.extend({ kind: z.literal('eval'), payload: EvalRunReportSchema }),
  ReportBaseSchema.extend({
    kind: z.literal('agent-suite'),
    payload: AgentSuiteReportSchema,
    suite: AgentSuiteSchema,
  }),
]) as unknown as z.ZodType<AiLabReportEnvelope>;

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
