'use client';

/**
 * Ambient TypeScript declarations for the script sandbox API, registered with
 * Monaco so the pre-request / test script editors get autocomplete, member
 * completion (`rs.`, `rs.response.`), hover docs and signature help.
 *
 * The sandbox (QuickJS, see `scriptExecutor.ts`) injects `rs` / `pm`,
 * `console`, `request`, `response`, `environment` and `globals` as **bare
 * globals** — so they are declared here as top-level `declare const`, NOT on
 * `interface Window`. This string MUST stay a plain ambient script: the moment
 * a top-level `import`/`export` appears it becomes a module and every
 * `declare const` stops being a global, silently killing completions.
 *
 * This is a hand-written IntelliSense aid, not a generated artifact — it may
 * drift from the live `rs`/`pm` object built in `scriptExecutor.ts`. Keep it
 * reasonably complete; accept that it can lag the runtime.
 */
export const SCRIPT_API_DTS = `
/** A variable scope (environment / globals / collection / data). */
interface ResturaVariableScope {
  /** Read a variable, or undefined if unset. */
  get(key: string): string | undefined;
  /** Write a variable for this run. */
  set(key: string, value: string): void;
  /** Remove a variable. */
  unset(key: string): void;
  /** True if the variable is set. */
  has(key: string): boolean;
}

/** Chai-style assertion chain returned by rs.expect(value). */
interface ResturaAssertion {
  /** Negate the next assertion. */
  not: ResturaAssertion;
  to: {
    not: ResturaAssertion;
    /** Strict equality (===). */
    equal(expected: unknown): void;
    /** Deep equality. */
    eql(expected: unknown): void;
    be: {
      /** Assert the value's type, e.g. 'string', 'number', 'object'. */
      a(type: string): void;
      an(type: string): void;
      /** Assert the value is exactly true. */
      true: void;
      /** Assert the value is exactly false. */
      false: void;
      /** Assert the value is null. */
      null: void;
      /** Assert the value is undefined. */
      undefined: void;
      /** Assert the value is truthy. */
      ok: void;
      /** Assert value < n. */
      below(n: number): void;
      /** Assert value > n. */
      above(n: number): void;
    };
    have: {
      /** Assert an own property exists (optionally equal to value). */
      property(name: string, value?: unknown): void;
      /** Assert .length === len. */
      length(len: number): void;
      /** Assert .length === len. */
      lengthOf(len: number): void;
    };
    /** Assert a string/array includes value. */
    include(value: unknown): void;
  };
}

/** Response assertions and accessors (rs.response). */
interface ResturaPmResponse {
  to: {
    have: {
      /** Assert the HTTP status code equals \`code\`. */
      status(code: number): void;
      /** Assert a response header is present (optionally equal to value). */
      header(key: string, value?: string): void;
      /** Assert the raw body (optionally equal to value). */
      body(value?: unknown): void;
      /** Assert the JSON body, optionally at a path, equals value. */
      jsonBody(path?: string, value?: unknown): void;
    };
    be: {
      /** Assert a 2xx status. */
      ok(): void;
      /** Assert the body parses as JSON. */
      json(): void;
      /** Assert an HTML content-type. */
      html(): void;
      /** Assert a 1xx status. */
      info(): void;
      /** Assert a 2xx status. */
      success(): void;
      /** Assert a 3xx status. */
      redirection(): void;
      /** Assert a 4xx status. */
      clientError(): void;
      /** Assert a 5xx status. */
      serverError(): void;
      /** Assert a 4xx or 5xx status. */
      error(): void;
    };
  };
  time: {
    /** Assert the response time is below \`ms\` milliseconds. */
    below(ms: number): void;
  };
  /** Parse and return the response body as JSON. */
  json(): any;
  /** Return the response body as text. */
  text(): string;
  /** HTTP status code. */
  readonly code: number;
  /** HTTP status text. */
  readonly status: string;
  /** Response time in milliseconds. */
  readonly responseTime: number;
}

/** Outgoing request as seen by the script (rs.request). */
interface ResturaPmRequest {
  /** Request URL. */
  url: string;
  /** HTTP method. */
  method: string;
  /** Request headers map. */
  headers: Record<string, string>;
  /** Request body (parsed when JSON, else raw). */
  body?: unknown;
}

/** Metadata about the current run (rs.info). */
interface ResturaPmInfo {
  /** Name of the request being executed. */
  readonly requestName: string;
  /** Id of the request being executed. */
  readonly requestId: string;
  /** 0-based iteration index (collection runner). */
  readonly iteration: number;
  /** Total iteration count (collection runner). */
  readonly iterationCount: number;
  /** Which script phase is running: 'prerequest' or 'test'. */
  readonly eventName: string;
}

/** Result of rs.sendRequest. */
interface ResturaSendResponse {
  code: number;
  status: string;
  headers: Record<string, string>;
  body: unknown;
  responseTime: number;
  responseSize: number;
}

/** A single cookie's value accessors. */
interface ResturaCookieJar {
  get(url: string, name: string): Promise<string | undefined>;
  getAll(url: string): Promise<Record<string, string>>;
  set(url: string, name: string, value: string): Promise<void>;
  unset(url: string, name: string): Promise<void>;
  clear(url: string): Promise<void>;
}

/** Cookie access (rs.cookies). */
interface ResturaCookies {
  get(name: string): string | undefined;
  has(name: string): boolean;
  toJSON(): Array<Record<string, unknown>>;
  jar(): ResturaCookieJar;
}

/** Encrypted secret vault (rs.vault). */
interface ResturaVault {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  unset(key: string): Promise<void>;
}

/** Runner flow control (rs.execution). */
interface ResturaExecution {
  /** Queue the named request next (null clears). */
  setNextRequest(name: string | null | undefined): void;
  /** Skip the current request. */
  skipRequest(): void;
  readonly location: {
    currentRequestName: string;
    folderPath: string[];
    collectionName: string;
  };
}

/** Iteration data row (rs.iterationData). */
interface ResturaIterationData extends ResturaVariableScope {
  /** Return the whole data row as an object. */
  toObject(): Record<string, string>;
}

/** The Restura script API, exposed as both \`rs\` and \`pm\`. */
interface ResturaScriptApi {
  /** Define a named test case. Assertions inside determine pass/fail. */
  test(name: string, fn: () => void | Promise<void>): void;
  /** Begin an assertion chain on a value. */
  expect(actual: unknown): ResturaAssertion;
  /** The response (test scripts). */
  response: ResturaPmResponse;
  /** The outgoing request. */
  request: ResturaPmRequest;
  /** Metadata about the current run. */
  info: ResturaPmInfo;
  /** Active variable scope (resolves env → collection → globals). */
  variables: ResturaVariableScope;
  /** Environment variables. */
  environment: ResturaVariableScope;
  /** Global variables. */
  globals: ResturaVariableScope;
  /** Collection variables. */
  collectionVariables: ResturaVariableScope;
  /** Current iteration data row (collection runner). */
  iterationData: ResturaIterationData;
  /** Cookie access. */
  cookies: ResturaCookies;
  /** Encrypted secret vault. */
  vault: ResturaVault;
  /** Runner flow control. */
  execution: ResturaExecution;
  /** Send an ad-hoc HTTP request. */
  sendRequest(
    input: string | { url: string; method?: string; headers?: Record<string, string>; body?: unknown },
    callback?: (err: Error | null, response: ResturaSendResponse) => void,
  ): Promise<ResturaSendResponse>;
  /** Render a visualizer template with data. */
  visualizer: { set(template: string, data: unknown): void };
}

/** Top-level request data (also available as rs.request). */
interface ResturaRequestGlobal {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

/** Top-level response data. */
interface ResturaResponseGlobal {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: unknown;
  /** Response time in milliseconds. */
  time: number;
  /** Response size in bytes. */
  size: number;
}

/** The Restura script API (primary alias used in templates). */
declare const rs: ResturaScriptApi;
/** The Restura script API (Postman-compatible alias). */
declare const pm: ResturaScriptApi;
/** The current request. */
declare const request: ResturaRequestGlobal;
/** The current response (test scripts only). */
declare const response: ResturaResponseGlobal;
/** Environment variables. */
declare const environment: ResturaVariableScope;
/** Global variables. */
declare const globals: ResturaVariableScope;

/** Legacy pre-\`pm\` Postman API — prefer \`pm.*\` / \`rs.*\` in new scripts. */
interface ResturaLegacyPostmanApi {
  setEnvironmentVariable(key: string, value: string): void;
  getEnvironmentVariable(key: string): string | undefined;
  clearEnvironmentVariable(key: string): void;
  setGlobalVariable(key: string, value: string): void;
  getGlobalVariable(key: string): string | undefined;
  clearGlobalVariable(key: string): void;
  setNextRequest(name: string | null | undefined): void;
}
/** Legacy Postman API alias (predates \`pm.*\`). */
declare const postman: ResturaLegacyPostmanApi;
/** Legacy \`tests["label"] = true/false\` object-literal test style. */
declare const tests: Record<string, boolean>;
`;

let registered = false;

interface JsLanguageDefaults {
  addExtraLib(content: string, filePath?: string): { dispose(): void };
}

/**
 * Registers the script API type definitions with Monaco's JS language service.
 * Idempotent — Monaco is a singleton, so the extra lib is added at most once.
 *
 * The curated Monaco ESM build (see monaco-setup.ts) trims the full barrel, so
 * `monaco.languages.typescript` is NEVER assigned — that only happens in
 * `editor.main.js`. The `javascriptDefaults` we need is a named export of the
 * typescript contribution module instead. monaco-setup already imports that
 * module for its side-effects, so this dynamic import resolves to the cached
 * module (no extra fetch) while keeping Monaco out of the eager ScriptsEditor
 * chunk.
 */
export async function registerScriptIntellisense(): Promise<void> {
  if (registered) return;
  registered = true;
  const mod = (await import('monaco-editor/esm/vs/language/typescript/monaco.contribution')) as {
    javascriptDefaults: JsLanguageDefaults;
  };
  mod.javascriptDefaults.addExtraLib(SCRIPT_API_DTS, 'ts:restura-scripts.d.ts');
}
