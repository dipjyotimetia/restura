import type { z } from 'zod';
import type { AgentRunResult } from './runner';
import type {
  AgentDefinitionSchema,
  AgentSuiteSchema,
  AgentTaskSchema,
  ContentBlockSchema,
  CredentialRefSchema,
  GraderSchema,
  KnowledgeSourceSchema,
  KnowledgeSourceDescriptorSchema,
  ModelRefSchema,
  SourceProvenanceSchema,
  ToolSourceSchema,
  TraceEventSchema,
} from './schema';

export type ContentBlock = z.infer<typeof ContentBlockSchema>;
export type CredentialRef = z.infer<typeof CredentialRefSchema>;
export type ModelRef = z.infer<typeof ModelRefSchema>;
export type ToolSource = z.infer<typeof ToolSourceSchema>;
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;
export type AgentTask = z.infer<typeof AgentTaskSchema>;
export type Grader = z.infer<typeof GraderSchema>;
export type AgentSuite = z.infer<typeof AgentSuiteSchema>;
export type TraceEvent = z.infer<typeof TraceEventSchema>;
export type KnowledgeSource = z.infer<typeof KnowledgeSourceSchema>;
export type KnowledgeSourceDescriptor = z.infer<typeof KnowledgeSourceDescriptorSchema>;
export type SourceProvenance = z.infer<typeof SourceProvenanceSchema>;

export interface AgentGradingContext {
  task: AgentTask;
  result: AgentRunResult;
  inputText: string;
  reference?: string;
  outputText: string;
  signal?: AbortSignal;
}

export interface Trace {
  id: string;
  suiteId: string;
  taskId: string;
  trial: number;
  agentId: string;
  startedAt: number;
  finishedAt?: number;
  events: TraceEvent[];
}
