// Agent2Agent (A2A) client for the `a2a` tool source: lets an agent suite call
// a remote A2A agent as a tool. Speaks JSON-RPC 2.0 (`message/send`, then
// `tasks/get` polling until the task settles, `tasks/cancel` on abort) against
// the endpoint named by the agent card. Every HTTP call goes through the
// injected transport, which each platform backs with its SSRF-guarded path
// (desktop: the real request executor; CLI: the DNS-pinned session). Streaming
// (`message/stream`) is deliberately unused: a tool call needs the settled
// result, and both transports buffer response bodies.
import { z } from 'zod';
import type { AgentTool, PermissionClass } from './runner';
import type { AgentToolSourceAdapter } from './tool-resolver';
import type { ContentBlock, ToolSource } from './types';

export interface A2aHttpRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body?: string;
}

export interface A2aHttpResponse {
  status: number;
  body: string;
}

export type A2aTransport = (
  request: A2aHttpRequest,
  signal?: AbortSignal
) => Promise<A2aHttpResponse>;

/** Current (v0.3) path first, then the pre-0.3 name still served by many agents. */
export const A2A_AGENT_CARD_PATHS = ['/.well-known/agent-card.json', '/.well-known/agent.json'];

const SkillSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
});

export const A2aAgentCardSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(10_000).optional(),
  url: z.url(),
  version: z.string().optional(),
  preferredTransport: z.string().optional(),
  capabilities: z.object({ streaming: z.boolean().optional() }).partial().optional(),
  skills: z.array(SkillSchema).max(200).optional(),
});

export type A2aAgentCard = z.infer<typeof A2aAgentCardSchema>;

const PartSchema = z.union([
  z.object({ kind: z.literal('text'), text: z.string() }),
  z.object({ kind: z.literal('data'), data: z.unknown() }),
  z.object({
    kind: z.literal('file'),
    file: z.object({ name: z.string().optional(), mimeType: z.string().optional() }).loose(),
  }),
]);

const MessageSchema = z.object({
  kind: z.literal('message'),
  messageId: z.string().optional(),
  contextId: z.string().optional(),
  taskId: z.string().optional(),
  parts: z.array(PartSchema),
});

const TaskSchema = z.object({
  kind: z.literal('task'),
  id: z.string(),
  contextId: z.string().optional(),
  status: z.object({
    state: z.string(),
    message: MessageSchema.optional(),
  }),
  artifacts: z
    .array(z.object({ artifactId: z.string().optional(), parts: z.array(PartSchema) }))
    .optional(),
});

const RpcResponseSchema = z.union([
  z.object({ jsonrpc: z.literal('2.0'), result: z.union([TaskSchema, MessageSchema]) }),
  z.object({
    jsonrpc: z.literal('2.0'),
    error: z.object({ code: z.number(), message: z.string() }),
  }),
]);

type A2aTask = z.infer<typeof TaskSchema>;
type A2aMessage = z.infer<typeof MessageSchema>;
type A2aPart = z.infer<typeof PartSchema>;

/** The task ended without a result the caller can use. */
const FAILED_STATES = new Set(['failed', 'rejected', 'canceled']);
/** The remote agent needs more from the caller; returned so the model can reply. */
const INTERRUPTED_STATES = new Set(['input-required', 'auth-required']);

export interface A2aClientOptions {
  /** Extra headers on every call (CLI: env-sourced auth). Never logged. */
  headers?: Record<string, string>;
  pollIntervalMs?: number;
  /** Give up waiting for a task to settle after this long. */
  maxWaitMs?: number;
  now?: () => number;
}

export interface A2aSendInput {
  message: string;
  contextId?: string;
  taskId?: string;
}

export interface A2aSendResult {
  state: string;
  taskId?: string;
  contextId?: string;
  content: ContentBlock[];
}

function abortError(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new DOMException('A2A call cancelled', 'AbortError');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function assertHttpUrl(raw: string, what: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`A2A ${what} is not a valid URL`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`A2A ${what} must use http or https`);
  }
  if (url.username || url.password) throw new Error(`A2A ${what} must not embed credentials`);
  return url;
}

function partsToContent(parts: A2aPart[]): ContentBlock[] {
  return parts.map((part): ContentBlock => {
    if (part.kind === 'text') return { type: 'text', text: part.text };
    if (part.kind === 'data') return { type: 'json', value: part.data };
    const label = [part.file.name, part.file.mimeType].filter(Boolean).join(', ');
    return { type: 'text', text: `[file part omitted${label ? `: ${label}` : ''}]` };
  });
}

function taskContent(task: A2aTask): ContentBlock[] {
  return [
    ...(task.artifacts ?? []).flatMap((artifact) => partsToContent(artifact.parts)),
    ...(task.status.message ? partsToContent(task.status.message.parts) : []),
  ];
}

function textOf(content: ContentBlock[]): string {
  return content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join(' ')
    .slice(0, 500);
}

export class A2aClient {
  private card: A2aAgentCard | undefined;
  private readonly endpoint: URL;

  constructor(
    endpoint: string,
    private readonly transport: A2aTransport,
    private readonly options: A2aClientOptions = {}
  ) {
    this.endpoint = assertHttpUrl(endpoint, 'endpoint');
  }

  /**
   * The suite endpoint is either the agent card URL itself (a `.json` path) or
   * the agent's base URL, in which case the well-known card paths are tried.
   */
  async fetchAgentCard(signal?: AbortSignal): Promise<A2aAgentCard> {
    if (this.card) return this.card;
    const candidates = this.endpoint.pathname.endsWith('.json')
      ? [this.endpoint.toString()]
      : A2A_AGENT_CARD_PATHS.map((path) => new URL(path, this.endpoint.origin).toString());
    let lastStatus = 0;
    for (const url of candidates) {
      const response = await this.transport(
        { method: 'GET', url, headers: { accept: 'application/json', ...this.options.headers } },
        signal
      );
      if (response.status === 404) {
        lastStatus = 404;
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`A2A agent card request failed with HTTP ${response.status}`);
      }
      const parsed = A2aAgentCardSchema.safeParse(safeJson(response.body));
      if (!parsed.success) throw new Error('A2A agent card is not valid');
      // A card must not steer calls to a different host than the one the suite names:
      // the suite author approved that origin, not whatever the card claims.
      const rpc = assertHttpUrl(parsed.data.url, 'agent card url');
      if (rpc.origin !== this.endpoint.origin) {
        throw new Error(
          `A2A agent card points at ${rpc.origin}, not the suite endpoint origin ${this.endpoint.origin}`
        );
      }
      if (parsed.data.preferredTransport && parsed.data.preferredTransport !== 'JSONRPC') {
        throw new Error(
          `A2A agent prefers ${parsed.data.preferredTransport}; only JSONRPC is supported`
        );
      }
      this.card = parsed.data;
      return parsed.data;
    }
    throw new Error(`A2A agent card not found (HTTP ${lastStatus || 'no response'})`);
  }

  async send(input: A2aSendInput, signal?: AbortSignal): Promise<A2aSendResult> {
    const card = await this.fetchAgentCard(signal);
    const result = await this.rpc(
      card.url,
      'message/send',
      {
        message: {
          kind: 'message',
          role: 'user',
          messageId: crypto.randomUUID(),
          parts: [{ kind: 'text', text: input.message }],
          ...(input.contextId ? { contextId: input.contextId } : {}),
          ...(input.taskId ? { taskId: input.taskId } : {}),
        },
        configuration: { blocking: true, acceptedOutputModes: ['text/plain', 'application/json'] },
      },
      signal
    );
    if (result.kind === 'message') return messageResult(result);
    return this.settle(card.url, result, signal);
  }

  private async settle(
    rpcUrl: string,
    initial: A2aTask,
    signal?: AbortSignal
  ): Promise<A2aSendResult> {
    const now = this.options.now ?? Date.now;
    const deadline = now() + (this.options.maxWaitMs ?? 60_000);
    let task = initial;
    try {
      while (!isSettled(task.status.state)) {
        if (now() > deadline) {
          throw new Error(
            `A2A task ${task.id} did not finish in time (state ${task.status.state})`
          );
        }
        await sleep(this.options.pollIntervalMs ?? 500, signal);
        const next = await this.rpc(rpcUrl, 'tasks/get', { id: task.id }, signal);
        if (next.kind !== 'task') throw new Error('A2A tasks/get did not return a task');
        task = next;
      }
    } catch (error) {
      if (signal?.aborted) await this.cancelQuietly(rpcUrl, task.id);
      throw error;
    }
    const content = taskContent(task);
    if (FAILED_STATES.has(task.status.state)) {
      const detail = textOf(content);
      throw new Error(`A2A task ${task.status.state}${detail ? `: ${detail}` : ''}`);
    }
    return {
      state: task.status.state,
      taskId: task.id,
      ...(task.contextId ? { contextId: task.contextId } : {}),
      content,
    };
  }

  private async cancelQuietly(rpcUrl: string, taskId: string): Promise<void> {
    try {
      // Fresh, short-lived signal: the run's signal is already aborted.
      await this.rpc(rpcUrl, 'tasks/cancel', { id: taskId }, AbortSignal.timeout(5_000));
    } catch {
      // Best effort: the remote task may already be gone.
    }
  }

  private async rpc(
    url: string,
    method: string,
    params: unknown,
    signal?: AbortSignal
  ): Promise<A2aTask | A2aMessage> {
    const response = await this.transport(
      {
        method: 'POST',
        url,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...this.options.headers,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }),
      },
      signal
    );
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`A2A ${method} failed with HTTP ${response.status}`);
    }
    const parsed = RpcResponseSchema.safeParse(safeJson(response.body));
    if (!parsed.success) throw new Error(`A2A ${method} returned an invalid JSON-RPC response`);
    if ('error' in parsed.data) {
      throw new Error(
        `A2A ${method} error ${parsed.data.error.code}: ${parsed.data.error.message}`
      );
    }
    return parsed.data.result;
  }
}

function isSettled(state: string): boolean {
  return state === 'completed' || FAILED_STATES.has(state) || INTERRUPTED_STATES.has(state);
}

function messageResult(message: A2aMessage): A2aSendResult {
  return {
    state: 'completed',
    ...(message.taskId ? { taskId: message.taskId } : {}),
    ...(message.contextId ? { contextId: message.contextId } : {}),
    content: partsToContent(message.parts),
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Provider-facing tool names must fit `^[a-zA-Z0-9_-]{1,64}$`. */
export function a2aToolName(card: A2aAgentCard): string {
  const slug = card.name.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return `a2a_${slug || 'agent'}`.slice(0, 64);
}

function describeAgent(card: A2aAgentCard): string {
  const skills = (card.skills ?? [])
    .slice(0, 20)
    .map((skill) => `${skill.name}${skill.description ? `: ${skill.description}` : ''}`)
    .join('; ');
  return [
    `Send a message to the remote A2A agent "${card.name}" and get its reply.`,
    card.description,
    skills ? `Skills: ${skills}.` : undefined,
    'Pass contextId (and taskId when the agent asked for input) from a previous reply to continue the conversation.',
  ]
    .filter(Boolean)
    .join(' ')
    .slice(0, 4_000);
}

function parseA2aArguments(arguments_: unknown): A2aSendInput {
  if (!arguments_ || typeof arguments_ !== 'object') throw new Error('A2A tool needs { message }');
  const { message, contextId, taskId } = arguments_ as Record<string, unknown>;
  if (typeof message !== 'string' || !message.trim()) {
    throw new Error('A2A tool needs a non-empty message string');
  }
  for (const [name, value] of [
    ['contextId', contextId],
    ['taskId', taskId],
  ] as const) {
    if (value !== undefined && typeof value !== 'string') {
      throw new Error(`A2A tool ${name} must be a string`);
    }
  }
  return {
    message,
    ...(typeof contextId === 'string' ? { contextId } : {}),
    ...(typeof taskId === 'string' ? { taskId } : {}),
  };
}

/** Build the agent tool for one remote A2A agent; the card is fetched once, here. */
export async function createA2aTool(
  client: A2aClient,
  permissionClass: PermissionClass,
  signal?: AbortSignal
): Promise<AgentTool> {
  const card = await client.fetchAgentCard(signal);
  return {
    definition: {
      name: a2aToolName(card),
      description: describeAgent(card),
      inputSchema: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'What to ask the remote agent' },
          contextId: { type: 'string', description: 'Conversation id from an earlier reply' },
          taskId: { type: 'string', description: 'Task id when the agent asked for more input' },
        },
        required: ['message'],
        additionalProperties: false,
      },
    },
    permissionClass,
    async execute(arguments_, context) {
      const result = await client.send(parseA2aArguments(arguments_), context.signal);
      return [
        ...result.content,
        {
          type: 'json',
          value: {
            a2a: {
              state: result.state,
              ...(result.taskId ? { taskId: result.taskId } : {}),
              ...(result.contextId ? { contextId: result.contextId } : {}),
            },
          },
        },
      ];
    },
  };
}

/**
 * Desktop-style adapter: every `a2a` source becomes one approval-required
 * (`network`) tool. The CLI builds its tools from the runtime manifest instead.
 */
export function createA2aToolSourceAdapter(
  transport: A2aTransport,
  options: A2aClientOptions = {}
): AgentToolSourceAdapter {
  return {
    kind: 'a2a',
    assertSource(source) {
      if (source.kind === 'a2a') assertHttpUrl(source.endpoint, 'endpoint');
    },
    async resolve(source: ToolSource, signal) {
      if (source.kind !== 'a2a') throw new Error(`a2a adapter cannot resolve ${source.kind} tools`);
      return [
        await createA2aTool(new A2aClient(source.endpoint, transport, options), 'network', signal),
      ];
    },
  };
}
