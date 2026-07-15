import { z } from 'zod';
import type { AgentTool } from './runner';
import { AgentSuiteSchema, ContentBlockSchema, IdentifierSchema } from './schema';
import type { AgentSuiteReport } from './suite-runner';
import type { AgentToolSourceAdapter } from './tool-resolver';
import type { ToolSource } from './types';

export const AGENT_BUNDLE_SCHEMA_VERSION = 1 as const;

const FixtureToolSchema = z.object({
  name: IdentifierSchema,
  description: z.string().min(1).max(2_000),
  inputSchema: z.record(z.string(), z.unknown()),
});

export const AgentFixtureSchema = z.object({
  id: IdentifierSchema,
  tool: FixtureToolSchema,
  expectedArguments: z.unknown().optional(),
  output: z.array(ContentBlockSchema).min(1),
});

export const AgentBundleBaselineSchema = z.object({
  minPassRate: z.number().min(0).max(1).optional(),
  maxLatencyMs: z.number().nonnegative().optional(),
});

export const AgentBundleSchema = z
  .object({
    schemaVersion: z.literal(AGENT_BUNDLE_SCHEMA_VERSION),
    id: IdentifierSchema,
    name: z.string().min(1).max(500),
    suite: AgentSuiteSchema,
    fixtures: z.array(AgentFixtureSchema),
    baseline: AgentBundleBaselineSchema.optional(),
  })
  .superRefine((bundle, context) => {
    const fixtureIds = new Set<string>();
    for (const [index, fixture] of bundle.fixtures.entries()) {
      if (fixtureIds.has(fixture.id)) {
        context.addIssue({
          code: 'custom',
          message: `duplicate fixture id: ${fixture.id}`,
          path: ['fixtures', index, 'id'],
        });
      }
      fixtureIds.add(fixture.id);
    }
    for (const [agentIndex, agent] of bundle.suite.agents.entries()) {
      if (agent.model.credential?.source === 'secret-handle') {
        context.addIssue({
          code: 'custom',
          message: 'Git-native bundles cannot contain secret-handle credentials',
          path: ['suite', 'agents', agentIndex, 'model', 'credential'],
        });
      }
      for (const [toolIndex, tool] of agent.tools.entries()) {
        if (tool.kind === 'fixture' && !fixtureIds.has(tool.fixtureId)) {
          context.addIssue({
            code: 'custom',
            message: `unknown fixture: ${tool.fixtureId}`,
            path: ['suite', 'agents', agentIndex, 'tools', toolIndex],
          });
        }
      }
    }
    for (const [graderIndex, grader] of bundle.suite.graders.entries()) {
      if (grader.kind !== 'judge') continue;
      for (const [modelIndex, model] of grader.judgeModels.entries()) {
        if (model.credential?.source !== 'secret-handle') continue;
        context.addIssue({
          code: 'custom',
          message: 'Git-native bundles cannot contain secret-handle credentials',
          path: ['suite', 'graders', graderIndex, 'judgeModels', modelIndex, 'credential'],
        });
      }
    }
  });

export type AgentBundle = z.infer<typeof AgentBundleSchema>;

export interface AgentBundleBaselineGate {
  metric: 'passRate' | 'maxLatencyMs';
  expected: number;
  actual: number;
  passed: boolean;
}

export function evaluateAgentBundleBaseline(
  bundle: AgentBundle,
  report: AgentSuiteReport
): AgentBundleBaselineGate[] {
  const baseline = bundle.baseline;
  if (!baseline) return [];
  const gates: AgentBundleBaselineGate[] = [];
  if (baseline.minPassRate !== undefined) {
    gates.push({
      metric: 'passRate',
      expected: baseline.minPassRate,
      actual: report.summary.passRate,
      passed: report.summary.passRate >= baseline.minPassRate,
    });
  }
  if (baseline.maxLatencyMs !== undefined) {
    const maxLatencyMs = Math.max(
      0,
      ...report.results.map(
        (result) => (result.trace.finishedAt ?? result.trace.startedAt) - result.trace.startedAt
      )
    );
    gates.push({
      metric: 'maxLatencyMs',
      expected: baseline.maxLatencyMs,
      actual: maxLatencyMs,
      passed: maxLatencyMs <= baseline.maxLatencyMs,
    });
  }
  return gates;
}

export function applyAgentBundleBaseline(
  report: AgentSuiteReport,
  gates: AgentBundleBaselineGate[]
): AgentSuiteReport {
  return gates.some((gate) => !gate.passed) ? { ...report, status: 'failed' } : report;
}

/** Resolve only deterministic, local fixture tools. Live request and MCP
 * sources remain the responsibility of their platform runtime adapters. */
export function resolveFixtureTools(
  sources: ToolSource[],
  fixtures: z.infer<typeof AgentFixtureSchema>[]
): AgentTool[] {
  const fixtureById = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
  return sources.flatMap((source) => {
    if (source.kind !== 'fixture') return [];
    return [fixtureTool(fixtureById, source.fixtureId)];
  });
}

export function createFixtureToolSourceAdapter(
  fixtures: z.infer<typeof AgentFixtureSchema>[]
): AgentToolSourceAdapter {
  const fixtureById = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
  return {
    kind: 'fixture',
    async resolve(source) {
      if (source.kind !== 'fixture') {
        throw new Error(`fixture adapter cannot resolve ${source.kind} tools`);
      }
      return [fixtureTool(fixtureById, source.fixtureId)];
    },
  };
}

function fixtureTool(
  fixtureById: ReadonlyMap<string, z.infer<typeof AgentFixtureSchema>>,
  fixtureId: string
): AgentTool {
  const fixture = fixtureById.get(fixtureId);
  if (!fixture) throw new Error(`unknown fixture: ${fixtureId}`);
  return {
    definition: fixture.tool,
    permissionClass: 'read',
    async execute(arguments_, { signal }) {
      signal.throwIfAborted();
      if (
        fixture.expectedArguments !== undefined &&
        canonicalJson(arguments_) !== canonicalJson(fixture.expectedArguments)
      ) {
        throw new Error(`fixture ${fixture.id} arguments did not match the recorded scenario`);
      }
      return fixture.output;
    },
  };
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, candidate: unknown) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return candidate;
    return Object.fromEntries(
      Object.entries(candidate as Record<string, unknown>).sort(([left], [right]) =>
        left.localeCompare(right)
      )
    );
  });
}
