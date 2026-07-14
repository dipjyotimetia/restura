// Components

export { VariableExtractorConfig } from './components/VariableExtractorConfig';
export { WorkflowBuilder } from './components/WorkflowBuilder';
export { WorkflowExecutor } from './components/WorkflowExecutor';
export { WorkflowManager } from './components/WorkflowManager';
export { WorkflowStep } from './components/WorkflowStep';

// Hooks
export { useWorkflowExecution } from './hooks/useWorkflowExecution';
export {
  validateExtraction,
  validateWorkflow,
  validateWorkflowRequest,
  variableExtractionSchema,
  workflowRequestSchema,
  workflowSchema,
} from './lib/validators';

export {
  extractByHeader,
  extractByJsonPath,
  extractByRegex,
  extractVariables,
  parseJsonSafely,
  testExtraction,
} from './lib/variableExtractor';
// Library functions
export { executeWorkflow, type WorkflowExecutorOptions } from './lib/workflowExecutor';
