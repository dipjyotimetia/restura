import { z } from 'zod';

export const AGENT_SUITE_SCHEMA_VERSION = 2 as const;

const IdentifierSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);

export const CredentialRefSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('env'), name: z.string().min(1).max(200) }),
  z.object({ source: z.literal('secret-handle'), id: z.uuid() }),
]);

const TextBlockSchema = z.object({ type: z.literal('text'), text: z.string() });
const JsonBlockSchema = z.object({ type: z.literal('json'), value: z.unknown() });
const MediaBlockSchema = z
  .object({
    type: z.enum(['image', 'audio', 'document']),
    mimeType: z.string().min(1).max(200),
    data: z.string().optional(),
    uri: z.string().optional(),
    name: z.string().max(500).optional(),
  })
  .refine((block) => Boolean(block.data) !== Boolean(block.uri), {
    message: 'media content requires exactly one of data or uri',
  });
const ArtifactBlockSchema = z.object({
  type: z.literal('artifact'),
  artifactId: IdentifierSchema,
  name: z.string().max(500).optional(),
});
const RefusalBlockSchema = z.object({ type: z.literal('refusal'), reason: z.string() });
const ReasoningSummaryBlockSchema = z.object({
  type: z.literal('reasoning-summary'),
  text: z.string(),
});

export const ContentBlockSchema = z.union([
  TextBlockSchema,
  JsonBlockSchema,
  MediaBlockSchema,
  ArtifactBlockSchema,
  RefusalBlockSchema,
  ReasoningSummaryBlockSchema,
]);

export const ModelRefSchema = z.object({
  providerId: IdentifierSchema,
  model: z.string().min(1).max(500),
  credential: CredentialRefSchema.optional(),
  baseUrl: z.url().optional(),
  parameters: z.record(z.string(), z.unknown()).optional(),
});

export const ToolSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('restura-request'), requestId: IdentifierSchema }),
  z.object({
    kind: z.literal('mcp'),
    connectionId: IdentifierSchema,
    allowedTools: z.array(z.string()).optional(),
  }),
  z.object({ kind: z.literal('sandbox'), sandboxId: IdentifierSchema }),
  z.object({ kind: z.literal('a2a'), endpoint: z.url() }),
]);

export const AgentLimitsSchema = z.object({
  maxSteps: z.number().int().min(1).max(1_000),
  maxWallTimeMs: z.number().int().min(100).max(86_400_000),
  maxToolCalls: z.number().int().min(1).max(10_000).optional(),
  maxTokens: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Maximum total input and output tokens across the run.'),
  maxCostUSD: z.number().min(0).optional(),
  maxOutputBytes: z.number().int().min(1_024).max(100_000_000).optional(),
});

export const AgentDefinitionSchema = z.object({
  id: IdentifierSchema,
  model: ModelRefSchema,
  instructions: z.string().min(1),
  tools: z.array(ToolSourceSchema),
  limits: AgentLimitsSchema,
  handoffs: z.array(IdentifierSchema).optional(),
});

export const AgentTaskSchema = z.object({
  id: IdentifierSchema,
  input: z.array(ContentBlockSchema).min(1),
  reference: z.array(ContentBlockSchema).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const GraderBaseSchema = z.object({ id: IdentifierSchema, label: z.string().optional() });
export const GraderSchema = z.discriminatedUnion('kind', [
  GraderBaseSchema.extend({ kind: z.literal('exact'), value: z.string().optional() }),
  GraderBaseSchema.extend({ kind: z.literal('contains'), value: z.string().optional() }),
  GraderBaseSchema.extend({
    kind: z.literal('regex'),
    pattern: z.string(),
    flags: z.string().optional(),
  }),
  GraderBaseSchema.extend({
    kind: z.literal('json-schema'),
    schema: z.record(z.string(), z.unknown()),
  }),
  GraderBaseSchema.extend({
    kind: z.literal('tool'),
    toolName: z.string().optional(),
    argumentsSchema: z.record(z.string(), z.unknown()).optional(),
  }),
  GraderBaseSchema.extend({
    kind: z.literal('trajectory'),
    mode: z.enum(['exact', 'in-order', 'subsequence', 'unordered']),
    tools: z.array(z.string()),
  }),
  GraderBaseSchema.extend({ kind: z.literal('latency'), maxMs: z.number().positive() }),
  GraderBaseSchema.extend({ kind: z.literal('cost'), maxUSD: z.number().min(0) }),
  GraderBaseSchema.extend({
    kind: z.literal('judge'),
    judgeModels: z.array(ModelRefSchema).min(1),
    rubric: z.string().min(1),
    labels: z.array(z.string().min(1)).min(2),
    passingLabels: z.array(z.string().min(1)).min(1).optional(),
    anchors: z
      .array(
        z.object({
          input: z.string(),
          output: z.string(),
          label: z.string().min(1),
          score: z.number().min(0).max(1),
        })
      )
      .optional(),
    minimumAgreement: z.number().min(0.5).max(1).default(0.5),
    minimumQuorum: z.number().int().min(1).optional(),
    calibrated: z.boolean().default(false),
  }),
]);

export const AgentSuiteSchema = z
  .object({
    schemaVersion: z.literal(AGENT_SUITE_SCHEMA_VERSION),
    id: IdentifierSchema,
    name: z.string().min(1).max(500),
    mode: z.enum(['capability', 'regression']),
    agents: z.array(AgentDefinitionSchema).min(1),
    tasks: z.array(AgentTaskSchema).min(1),
    graders: z.array(GraderSchema),
    trials: z.number().int().min(1).max(100),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((suite, context) => {
    const assertUnique = (values: string[], path: string): void => {
      const seen = new Set<string>();
      for (const value of values) {
        if (seen.has(value)) {
          context.addIssue({
            code: 'custom',
            message: `duplicate ${path} id: ${value}`,
            path: [path],
          });
        }
        seen.add(value);
      }
    };
    assertUnique(
      suite.agents.map((agent) => agent.id),
      'agents'
    );
    assertUnique(
      suite.tasks.map((task) => task.id),
      'tasks'
    );
    assertUnique(
      suite.graders.map((grader) => grader.id),
      'graders'
    );
    const agentIds = new Set(suite.agents.map((agent) => agent.id));
    for (const agent of suite.agents) {
      for (const handoff of agent.handoffs ?? []) {
        if (!agentIds.has(handoff)) {
          context.addIssue({
            code: 'custom',
            message: `unknown handoff agent: ${handoff}`,
            path: ['agents'],
          });
        }
      }
    }
    for (const [graderIndex, grader] of suite.graders.entries()) {
      if (grader.kind !== 'judge') continue;
      const graderPath = ['graders', graderIndex] as const;
      const labels = new Set(grader.labels);
      const passingLabels = grader.passingLabels ?? [grader.labels[0]!];
      for (const [labelIndex, label] of passingLabels.entries()) {
        if (!labels.has(label)) {
          context.addIssue({
            code: 'custom',
            message: `passing label is not an allowed label: ${label}`,
            path: [...graderPath, 'passingLabels', labelIndex],
          });
        }
      }
      for (const [anchorIndex, anchor] of (grader.anchors ?? []).entries()) {
        if (!labels.has(anchor.label)) {
          context.addIssue({
            code: 'custom',
            message: `anchor label is not an allowed label: ${anchor.label}`,
            path: [...graderPath, 'anchors', anchorIndex, 'label'],
          });
        }
      }
      const seenModels = new Set<string>();
      for (const [modelIndex, model] of grader.judgeModels.entries()) {
        const modelId = `${model.providerId}\u0000${model.model}`;
        if (seenModels.has(modelId)) {
          context.addIssue({
            code: 'custom',
            message: `duplicate judge model: ${model.providerId}/${model.model}`,
            path: [...graderPath, 'judgeModels', modelIndex],
          });
        }
        seenModels.add(modelId);
      }
      if (grader.minimumQuorum !== undefined && grader.minimumQuorum > grader.judgeModels.length) {
        context.addIssue({
          code: 'custom',
          message: 'minimumQuorum cannot exceed the judge panel size',
          path: [...graderPath, 'minimumQuorum'],
        });
      }
      if (!grader.calibrated) continue;
      const anchors = grader.anchors ?? [];
      if (anchors.length < 2) {
        context.addIssue({
          code: 'custom',
          message: 'calibrated judge requires at least two anchors',
          path: [...graderPath, 'anchors'],
        });
        continue;
      }
      const passing = new Set(passingLabels);
      if (!anchors.some((anchor) => passing.has(anchor.label))) {
        context.addIssue({
          code: 'custom',
          message: 'calibration anchors require a passing-label example',
          path: [...graderPath, 'anchors'],
        });
      }
      if (!anchors.some((anchor) => labels.has(anchor.label) && !passing.has(anchor.label))) {
        context.addIssue({
          code: 'custom',
          message: 'calibration anchors require a non-passing-label example',
          path: [...graderPath, 'anchors'],
        });
      }
      const scores = anchors.map((anchor) => anchor.score);
      if (Math.max(...scores) - Math.min(...scores) < 0.5) {
        context.addIssue({
          code: 'custom',
          message: 'calibration anchor scores must span at least 0.5',
          path: [...graderPath, 'anchors'],
        });
      }
    }
  });

const TraceEventBaseSchema = z.object({
  id: IdentifierSchema,
  traceId: IdentifierSchema,
  sequence: z.number().int().min(0),
  timestamp: z.number().nonnegative(),
});

export const TraceEventSchema = z.discriminatedUnion('type', [
  TraceEventBaseSchema.extend({ type: z.literal('run.started'), agentId: IdentifierSchema }),
  TraceEventBaseSchema.extend({
    type: z.literal('run.completed'),
    status: z.enum(['passed', 'failed', 'error', 'cancelled']),
  }),
  TraceEventBaseSchema.extend({
    type: z.literal('model.requested'),
    providerId: IdentifierSchema,
    model: z.string(),
    input: z.array(ContentBlockSchema),
  }),
  TraceEventBaseSchema.extend({
    type: z.literal('model.completed'),
    providerId: IdentifierSchema,
    model: z.string(),
    output: z.array(ContentBlockSchema),
    durationMs: z.number().nonnegative(),
    usage: z
      .object({ inputTokens: z.number().nonnegative(), outputTokens: z.number().nonnegative() })
      .optional(),
    costUSD: z.number().nonnegative().optional(),
  }),
  TraceEventBaseSchema.extend({
    type: z.literal('model.failed'),
    providerId: IdentifierSchema,
    model: z.string(),
    error: z.string(),
    durationMs: z.number().nonnegative(),
  }),
  TraceEventBaseSchema.extend({
    type: z.literal('tool.requested'),
    toolCallId: IdentifierSchema,
    toolName: z.string().min(1),
    arguments: z.unknown(),
    permissionClass: z.enum([
      'read',
      'network',
      'mutation',
      'credential',
      'filesystem',
      'process',
      'destructive',
    ]),
  }),
  TraceEventBaseSchema.extend({
    type: z.literal('tool.completed'),
    toolCallId: IdentifierSchema,
    toolName: z.string().min(1),
    output: z.array(ContentBlockSchema),
    durationMs: z.number().nonnegative(),
  }),
  TraceEventBaseSchema.extend({
    type: z.literal('tool.failed'),
    toolCallId: IdentifierSchema,
    toolName: z.string().min(1),
    error: z.string(),
    durationMs: z.number().nonnegative(),
  }),
  TraceEventBaseSchema.extend({
    type: z.literal('approval.requested'),
    approvalId: IdentifierSchema,
    toolCallId: IdentifierSchema,
    permissionClass: z.string(),
  }),
  TraceEventBaseSchema.extend({
    type: z.literal('approval.resolved'),
    approvalId: IdentifierSchema,
    decision: z.enum(['approved', 'denied']),
  }),
  TraceEventBaseSchema.extend({
    type: z.literal('handoff'),
    fromAgentId: IdentifierSchema,
    toAgentId: IdentifierSchema,
  }),
]);
