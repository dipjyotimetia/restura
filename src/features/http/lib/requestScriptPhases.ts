/**
 * The pre-request and test script steps of an HTTP send, shared by the
 * buffered `executeRequest` and the web streaming `executeStreamingRequest`
 * so a streamed send runs the same scripts, with the same host, absorb and
 * header-edit rules, as a buffered one.
 */
import { findScriptWrittenToken } from '@shared/scripts/grpc-script-metadata';
import { applyScriptHeaderEdits } from '@shared/scripts/script-executor-request';
import { runScriptPhase } from '@shared/scripts/script-phase';
import { SecretVariableReferenceError } from '@shared/variables/secret-variable-token';
import { v4 as uuidv4 } from 'uuid';
import { useCookieStore } from '@/features/http/store/useCookieStore';
import type { ScriptResult } from '@/features/scripts/lib/scriptExecutor';
import { makeRendererScriptHost } from '@/features/scripts/lib/scriptPhaseHost.renderer';
import type { Response as ApiResponse, HttpRequest } from '@/types';

/** The executor options the script steps read (a subset of `RequestExecutorOptions`). */
export interface ScriptStepOptions {
  request: HttpRequest;
  envVars: Record<string, string>;
  secretNames?: readonly string[];
  signal?: AbortSignal;
  collectionVars?: Record<string, string>;
  iterationData?: Record<string, string>;
  info?: { requestName?: string; requestId?: string; iteration?: number; iterationCount?: number };
  location?: { currentRequestName: string; folderPath: string[]; collectionName: string };
}

/**
 * `pm.collectionVariables` / `pm.environment` writes collected across both
 * phases (test phase wins on conflict).
 */
export interface ScriptMutations {
  collectionVarsMutations: Record<string, string | null>;
  environmentMutations: Record<string, string | null>;
}

export function newScriptMutations(): ScriptMutations {
  return { collectionVarsMutations: {}, environmentMutations: {} };
}

function absorbMutations(into: ScriptMutations, result: ScriptResult): void {
  if (result.collectionMutations) {
    Object.assign(into.collectionVarsMutations, result.collectionMutations);
  }
  if (result.environmentMutations) {
    Object.assign(into.environmentMutations, result.environmentMutations);
  }
}

/** The non-empty mutation maps, spread into an execution result. */
export function mutationFields(mutations: ScriptMutations): {
  collectionVarsMutations?: Record<string, string | null>;
  environmentMutations?: Record<string, string | null>;
} {
  const { collectionVarsMutations, environmentMutations } = mutations;
  return {
    ...(Object.keys(collectionVarsMutations).length > 0 ? { collectionVarsMutations } : {}),
    ...(Object.keys(environmentMutations).length > 0 ? { environmentMutations } : {}),
  };
}

export type ScriptInfo = {
  requestName: string;
  requestId: string;
  iteration?: number;
  iterationCount?: number;
};

export function scriptInfo(options: ScriptStepOptions): ScriptInfo {
  return {
    requestName: options.info?.requestName ?? options.request.name,
    requestId: options.info?.requestId ?? options.request.id,
    ...(options.info?.iteration !== undefined ? { iteration: options.info.iteration } : {}),
    ...(options.info?.iterationCount !== undefined
      ? { iterationCount: options.info.iterationCount }
      : {}),
  };
}

export interface PreRequestStep {
  /** The request with the script's `rs.request.headers` edits applied. */
  requestToSend: HttpRequest;
  result?: ScriptResult;
  /** True when the script called `pm.execution.skipRequest()`. */
  skipRequested: boolean;
}

/**
 * Run the request's pre-request script (if any). Variable writes land in
 * `options.envVars` (kept even when the script errors, as in Postman), and
 * header edits are folded into `requestToSend`.
 */
export async function runPreRequestStep(
  options: ScriptStepOptions,
  info: ScriptInfo,
  mutations: ScriptMutations
): Promise<PreRequestStep> {
  const { request, envVars, collectionVars, iterationData, location, signal } = options;
  if (!request.preRequestScript) return { requestToSend: request, skipRequested: false };
  signal?.throwIfAborted();
  // Pre-request runs before buildProxyRequestSpec has resolved auth, so
  // the inherited-header set is the user-defined headers only. The test
  // script gets the fully-resolved sentHeaders including the Authorization
  // that auth-applier produced.
  const inheritedHeadersPre: Record<string, string> = Object.fromEntries(
    request.headers.filter((h) => h.enabled).map((h) => [h.key, h.value])
  );
  void useCookieStore; // keep the import side-effect for cookieAdapter's lazy store binding
  const pre = await runScriptPhase({
    phase: 'prerequest',
    script: request.preRequestScript,
    request: {
      url: request.url,
      method: request.method,
      headers: { ...inheritedHeadersPre },
      body: request.body.raw,
    },
    envVars,
    collectionVars,
    iterationData,
    info,
    location,
    host: makeRendererScriptHost({
      variables: envVars,
      secretNames: options.secretNames,
      parentUrlTemplate: request.url,
      inheritedHeaderTemplates: inheritedHeadersPre,
      signal,
    }),
    // As in Postman (and the gRPC / MCP / CLI hosts), writes made before a
    // script error are kept: the request is still sent with them.
    absorb: { into: envVars, variables: 'always' },
    afterRun: () => signal?.throwIfAborted(),
  });
  const result = pre.result;
  absorbMutations(mutations, result);
  let requestToSend = request;
  if (result.requestHeaders) {
    // Same rule as gRPC metadata: a script cannot put a secret-variable token
    // into a header that was not already written there (a script string can
    // be a server value). Nothing is sent.
    const written = findScriptWrittenToken(
      request.headers,
      result.requestHeaders,
      (name) => options.secretNames?.includes(name) === true
    );
    if (written) {
      throw new SecretVariableReferenceError(
        'rs.request.headers',
        written.name,
        `"${written.key}"`,
        'A script cannot add a secret variable to a request field.'
      );
    }
    requestToSend = {
      ...request,
      headers: applyScriptHeaderEdits(
        request.headers,
        inheritedHeadersPre,
        result.requestHeaders,
        uuidv4
      ),
    };
  }
  return { requestToSend, result, skipRequested: result.execution?.skipRequested === true };
}

export interface TestStepInput {
  info: ScriptInfo;
  /** Resolved URL and enabled header rows as sent (the CLI's test-phase request). */
  sentUrl: string;
  scriptHeaders: Record<string, string>;
  /** The wire URL and full sent header set, inherited by `pm.sendRequest`. */
  parentUrl: string;
  sentHeaders: Record<string, string>;
  response: ApiResponse;
}

/** Run the request's test script (if any) against `input.response`. */
export async function runTestStep(
  options: ScriptStepOptions,
  input: TestStepInput,
  mutations: ScriptMutations
): Promise<ScriptResult | undefined> {
  const { request, envVars, collectionVars, iterationData, location, signal } = options;
  if (!request.testScript) return undefined;
  signal?.throwIfAborted();
  const { response } = input;
  void useCookieStore; // keep the import side-effect for cookieAdapter's lazy store binding
  const test = await runScriptPhase({
    phase: 'test',
    script: request.testScript,
    // The request as sent: resolved URL and header-row values, as the CLI
    // gives its test phase (`cli/src/runner/scriptRunner.ts`).
    request: {
      url: input.sentUrl,
      method: request.method,
      headers: input.scriptHeaders,
      body: request.body.raw,
    },
    response: {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers as Record<string, string>,
      ...(response.setCookies !== undefined ? { setCookies: response.setCookies } : {}),
      body: response.body,
      time: response.time,
      size: response.size,
    },
    envVars,
    collectionVars,
    iterationData,
    info: input.info,
    location,
    // Test script gets the fully-resolved sentHeaders (auth + content-type +
    // framework defaults) so pm.sendRequest sub-requests inherit the same
    // Authorization the parent went out with. rs.judge is wired only here
    // (a response exists to judge).
    host: makeRendererScriptHost({
      variables: envVars,
      secretNames: options.secretNames,
      parentUrl: input.parentUrl,
      inheritedHeaders: input.sentHeaders,
      signal,
      judge: true,
    }),
    afterRun: () => signal?.throwIfAborted(),
  });
  absorbMutations(mutations, test.result);
  return test.result;
}
