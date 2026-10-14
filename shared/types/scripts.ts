// Script Execution Result
export interface ScriptResult {
  success: boolean;
  logs: Array<{ type: 'log' | 'error' | 'warn' | 'info'; message: string; timestamp: number }>;
  errors: string[];
  variables: Record<string, string>;
  tests?: Array<{ name: string; passed: boolean; error?: string }>;
  /** `pm.globals.set/unset` mutations the script applied (Phase A). */
  globalsMutations?: Record<string, string | null>;
  /** `pm.collectionVariables.set/unset` mutations (Phase A). */
  collectionMutations?: Record<string, string | null>;
  /** Runner flow control from `pm.execution.setNextRequest / skipRequest` (Phase A/C). */
  execution?: {
    nextRequest?: string | null;
    skipRequested?: boolean;
  };
  /**
   * Final `rs.request.metadata` after a pre-request script — present only when
   * the context supplied metadata (gRPC) AND the script changed it (#910).
   */
  requestMetadata?: Record<string, string>;
  /** `pm.visualizer.set(template, data)` payload (Phase D). */
  visualization?: {
    template: string;
    data: unknown;
  };
}
