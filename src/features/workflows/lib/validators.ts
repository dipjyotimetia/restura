import { z } from 'zod';

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
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const workflowExecutionStepSchema = z.object({
  workflowRequestId: z.string(),
  requestId: z.string(),
  requestName: z.string(),
  status: z.enum(['pending', 'running', 'success', 'failed', 'skipped']),
  extractedVariables: z.record(z.string()).optional(),
  error: z.string().optional(),
  duration: z.number().optional(),
  timestamp: z.number(),
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
  finalVariables: z.record(z.string()),
  environment: z.string().optional(),
  executionLog: z.array(executionLogEntrySchema),
});

// Validation helpers
export function validateWorkflow(data: unknown): { success: boolean; errors?: string[] } {
  const result = workflowSchema.safeParse(data);
  if (result.success) {
    return { success: true };
  }
  return {
    success: false,
    errors: result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`),
  };
}

export function validateWorkflowRequest(data: unknown): { success: boolean; errors?: string[] } {
  const result = workflowRequestSchema.safeParse(data);
  if (result.success) {
    return { success: true };
  }
  return {
    success: false,
    errors: result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`),
  };
}

export function validateExtraction(data: unknown): { success: boolean; errors?: string[] } {
  const result = variableExtractionSchema.safeParse(data);
  if (result.success) {
    return { success: true };
  }
  return {
    success: false,
    errors: result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`),
  };
}

// Type exports for use with Zod inference
export type ValidatedWorkflow = z.infer<typeof workflowSchema>;
export type ValidatedWorkflowRequest = z.infer<typeof workflowRequestSchema>;
export type ValidatedVariableExtraction = z.infer<typeof variableExtractionSchema>;
