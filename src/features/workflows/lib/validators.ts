import { z } from 'zod';
import { workflowGraphSchema, validateWorkflowGraph } from './flowValidators';

export const extractionMethodSchema = z.enum(['jsonpath', 'regex', 'header']);

export const variableExtractionSchema = z.object({
  id: z.string().min(1),
  variableName: z.string().min(1, 'Variable name is required'),
  extractionMethod: extractionMethodSchema,
  path: z.string().min(1, 'Path is required'),
  description: z.string().optional(),
});

export const retryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).max(10),
  delayMs: z.number().int().min(0).max(60000),
  backoffMultiplier: z.number().min(1).max(5).optional(),
});

export const workflowRequestSchema = z.object({
  id: z.string().min(1),
  requestId: z.string().min(1, 'Request ID is required'),
  name: z.string().min(1, 'Name is required'),
  extractVariables: z.array(variableExtractionSchema).optional(),
  precondition: z.string().optional(),
  retryPolicy: retryPolicySchema.optional(),
  timeout: z.number().int().min(1000).max(300000).optional(),
});

export const keyValueSchema = z.object({
  id: z.string().min(1),
  key: z.string(),
  value: z.string(),
  enabled: z.boolean(),
  description: z.string().optional(),
});

export const workflowSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1, 'Workflow name is required'),
  description: z.string().optional(),
  collectionId: z.string().min(1),
  requests: z.array(workflowRequestSchema),
  variables: z.array(keyValueSchema).optional(),
  graph: workflowGraphSchema.optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const flowNodeKindSchema = z.enum([
  'start',
  'end',
  'request',
  'condition',
  'setVariable',
  'delay',
  'transform',
  'parallel',
  'forEach',
  'tryCatch',
  'subWorkflow',
  'sseSubscribe',
  'wsExchange',
  'mcpCall',
]);

export const workflowExecutionStepSchema = z.object({
  // Legacy linear executions populate these; graph executions leave them
  // empty on non-request nodes.
  workflowRequestId: z.string().optional(),
  requestId: z.string().optional(),
  requestName: z.string(),
  status: z.enum(['pending', 'running', 'success', 'failed', 'skipped']),
  extractedVariables: z.record(z.string(), z.string()).optional(),
  error: z.string().optional(),
  duration: z.number().optional(),
  timestamp: z.number(),
  nodeId: z.string().optional(),
  nodeKind: flowNodeKindSchema.optional(),
});

export const executionLogEntrySchema = z.object({
  timestamp: z.number(),
  message: z.string(),
  level: z.enum(['info', 'warn', 'error']),
});

export const workflowExecutionSchema = z.object({
  id: z.string(),
  workflowId: z.string(),
  workflowName: z.string(),
  startedAt: z.number(),
  completedAt: z.number().optional(),
  status: z.enum(['running', 'success', 'failed', 'stopped']),
  steps: z.array(workflowExecutionStepSchema),
  finalVariables: z.record(z.string(), z.string()),
  environment: z.string().optional(),
  executionLog: z.array(executionLogEntrySchema),
});

// Validation helpers
export function validateWorkflow(data: unknown): { success: boolean; errors?: string[] } {
  const result = workflowSchema.safeParse(data);
  if (!result.success) {
    return {
      success: false,
      errors: result.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`),
    };
  }
  // `workflowGraphSchema` above only checks shape — it accepts a `graph`
  // with cycles, dangling edges, a missing start node, etc. `graph` is
  // re-validated through the same structural gate `dagExecutor.ts` and
  // `workflowIO.ts`'s import path rely on, so a `Workflow` this function
  // approves is actually runnable, not just shape-valid.
  if (result.data.graph) {
    const graphResult = validateWorkflowGraph(result.data.graph);
    if (!graphResult.ok) {
      const blocking = graphResult.issues.filter((i) => (i.severity ?? 'error') === 'error');
      if (blocking.length > 0) {
        return {
          success: false,
          errors: blocking.map((i) => `graph.${i.path}: ${i.message}`),
        };
      }
    }
  }
  return { success: true };
}

export function validateWorkflowRequest(data: unknown): { success: boolean; errors?: string[] } {
  const result = workflowRequestSchema.safeParse(data);
  if (result.success) {
    return { success: true };
  }
  return {
    success: false,
    errors: result.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`),
  };
}

export function validateExtraction(data: unknown): { success: boolean; errors?: string[] } {
  const result = variableExtractionSchema.safeParse(data);
  if (result.success) {
    return { success: true };
  }
  return {
    success: false,
    errors: result.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`),
  };
}

// Type exports for use with Zod inference
export type ValidatedWorkflow = z.infer<typeof workflowSchema>;
export type ValidatedWorkflowRequest = z.infer<typeof workflowRequestSchema>;
export type ValidatedVariableExtraction = z.infer<typeof variableExtractionSchema>;
