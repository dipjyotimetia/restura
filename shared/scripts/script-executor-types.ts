import type { JudgeRequestInput, JudgeVerdict } from '@shared/protocol/ai/judge';
import type { ScriptResult } from '../types';
import type { PmCookieAdapter, PmCookieRecord } from './cookie-adapter';

export type { PmCookieAdapter, PmCookieRecord, ScriptResult };

export interface PmRequestInfo {
  requestName?: string;
  requestId?: string;
  iteration?: number;
  iterationCount?: number;
  /** Postman-compatible: which script phase is running. */
  eventName?: 'prerequest' | 'test';
}

/**
 * Postman-compatible execution-location context bound onto `pm.execution.location`.
 * Populated by the collection runner; absent for one-off requests.
 */
export interface PmExecutionLocation {
  currentRequestName: string;
  folderPath: string[];
  collectionName: string;
}

/** Host-side capabilities injected by the harness. */
export interface ScriptHostBridges {
  /** Must use the same SSRF-guarded path as a top-level request. */
  sendRequest?: (input: PmSendRequestInput) => Promise<PmSubResponse>;
  /** Produces a URL-scoped cookie adapter for the active request. */
  cookies?: (currentUrl: string | undefined) => PmCookieAdapter;
  /** Vault key-value store for `pm.vault`. */
  vault?: PmVaultAdapter;
  /** LLM-as-judge bridge for `rs.judge(output, opts)`. */
  judge?: (input: JudgeRequestInput) => Promise<JudgeVerdict>;
}

export interface PmSendRequestInput {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface PmSubResponse {
  code: number;
  status: string;
  headers: Record<string, string>;
  body: string;
  responseTime: number;
  responseSize: number;
}

export interface PmVaultAdapter {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  unset(key: string): Promise<void>;
}

/** Full constructor shape for `new ScriptExecutor({...})`. */
export interface ScriptExecutorOptions {
  envVars?: Record<string, string>;
  globalVars?: Record<string, string>;
  collectionVars?: Record<string, string>;
  iterationData?: Record<string, string>;
  info?: PmRequestInfo;
  location?: PmExecutionLocation;
  host?: ScriptHostBridges;
}

export interface ScriptContext {
  request?: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body?: unknown;
  };
  response?: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: unknown;
    time: number;
    size: number;
  };
  environment: {
    get: (key: string) => string | undefined;
    set: (key: string, value: string) => void;
  };
  globals: {
    get: (key: string) => string | undefined;
    set: (key: string, value: string) => void;
  };
  console: {
    log: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
  };
  pm: {
    test: (name: string, fn: () => void) => void;
    expect: (actual: unknown) => {
      to: {
        equal: (expected: unknown) => void;
        be: { a: (type: string) => void; true: () => void; false: () => void };
        have: { property: (prop: string) => void; length: (len: number) => void };
      };
    };
    response: {
      to: {
        have: {
          status: (code: number) => void;
          header: (key: string, value?: string) => void;
          body: (value?: unknown) => void;
          jsonBody: (path?: string, value?: unknown) => void;
        };
        be: { ok: () => void; json: () => void; html: () => void };
      };
      time: { below: (ms: number) => void };
    };
    variables: {
      get: (key: string) => string | undefined;
      set: (key: string, value: string) => void;
    };
  };
}
