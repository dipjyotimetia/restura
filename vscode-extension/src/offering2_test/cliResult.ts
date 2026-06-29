/**
 * Local mirror of the CLI's JSON-reporter output shape
 * (`cli/src/reporters/types.ts` + `cli/src/runner/collectionLoader.ts`).
 *
 * Duplicated intentionally: importing the CLI's types would pull
 * `collectionLoader.ts` -> `@/types` / `to-internal` / `@/features/auth` into
 * this project's type graph. The JSON file is a serialization boundary, so a
 * structural mirror of the fields we read is the clean dependency-free seam.
 * If the CLI's reporter shape changes, this must move in lockstep.
 */

export interface CliAssertionResult {
  name: string;
  passed: boolean;
  error?: string;
}

export interface CliLoadedRequest {
  relativePath: string;
  folderPath: string[];
  type: 'http' | 'grpc' | 'sse' | 'mcp';
  request: { id?: string; name: string; url?: string };
}

export interface CliRequestRunResult {
  request: CliLoadedRequest;
  status: number;
  passed: boolean;
  durationMs: number;
  bodyBytes: number;
  errorMessage?: string;
  responseHeaders?: Record<string, string>;
  assertions?: CliAssertionResult[];
}

export interface CliRunResult {
  meta: { collectionName: string; collectionDir: string; startedAt: number };
  durationMs: number;
  requests: CliRequestRunResult[];
  summary: { total: number; passed: number; failed: number; errored: number };
}

// NUL separator: cannot appear in folder/request names, so keys never collide.
const KEY_SEP = '\0';

/**
 * Stable key joining folder path + request name. Matches the discovery side
 * (`ScannedRequest`) against the run-result side (`CliLoadedRequest`).
 */
export function resultKey(folderPath: string[], name: string): string {
  return [...folderPath, name].join(KEY_SEP);
}

/** One-line `✓/✗ name — error` summary of an assertion (no leading indent). */
export function formatAssertion(a: CliAssertionResult): string {
  return `${a.passed ? '✓' : '✗'} ${a.name}${a.error ? ` — ${a.error}` : ''}`;
}
