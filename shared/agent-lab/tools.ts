import type { AgentTool, PermissionClass } from './runner';
import type { AgentToolSourceAdapter } from './tool-resolver';
import type { ContentBlock, ToolSource } from './types';

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean };
}

export interface AgentMcpClient {
  listTools(signal?: AbortSignal): Promise<McpToolDescriptor[]>;
  callTool(name: string, arguments_: unknown, signal?: AbortSignal): Promise<ContentBlock[]>;
}

export interface CreateMcpToolsOptions {
  /** Namespacing prevents collisions between independent local MCP sessions. */
  nameForTool?(remoteName: string): string;
  /** Sees the allowed server descriptors (annotations included) before tools are built. */
  inspectDescriptors?(descriptors: McpToolDescriptor[]): void;
}

function permissionForMcpTool(tool: McpToolDescriptor): PermissionClass {
  if (tool.annotations?.destructiveHint) return 'destructive';
  if (tool.annotations?.openWorldHint) return 'network';
  // MCP annotations are untrusted hints, not authorization. Even a server that
  // claims readOnlyHint remains approval-required until a local trust policy exists.
  return 'mutation';
}

export async function createMcpTools(
  source: Extract<ToolSource, { kind: 'mcp' }>,
  client: AgentMcpClient,
  signal?: AbortSignal,
  options: CreateMcpToolsOptions = {}
): Promise<AgentTool[]> {
  const allowed = source.allowedTools ? new Set(source.allowedTools) : undefined;
  const descriptors = await client.listTools(signal);
  if (allowed) {
    const available = new Set(descriptors.map((tool) => tool.name));
    const missing = [...allowed].filter((name) => !available.has(name));
    if (missing.length > 0)
      throw new Error(`MCP server did not expose allowed tools: ${missing.join(', ')}`);
  }
  const exposed = descriptors.filter((tool) => !allowed || allowed.has(tool.name));
  options.inspectDescriptors?.(exposed);
  return exposed.map((tool) => ({
    definition: {
      name: options.nameForTool?.(tool.name) ?? tool.name,
      description: tool.description ?? tool.name,
      inputSchema: tool.inputSchema,
    },
    permissionClass: permissionForMcpTool(tool),
    execute: (arguments_, context) => client.callTool(tool.name, arguments_, context.signal),
  }));
}

export interface SandboxExecutionRequest {
  language: string;
  code: string;
  files?: Record<string, string>;
  timeoutMs: number;
  network: 'disabled' | 'restricted';
  maxOutputBytes: number;
}

export interface SandboxExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  artifacts?: Array<{ name: string; mimeType: string; data: string }>;
}

export interface SandboxProvider {
  readonly id: string;
  /** Languages the provider runs; the first is what the agent tool sends. Defaults to javascript. */
  readonly languages?: readonly string[];
  /**
   * What a call can do outside the sandbox. Defaults to `process` (approval
   * required); a provider with no host I/O may declare `read`.
   */
  readonly permissionClass?: PermissionClass;
  execute(request: SandboxExecutionRequest, signal?: AbortSignal): Promise<SandboxExecutionResult>;
}

export class SandboxRegistry {
  private readonly providers = new Map<string, SandboxProvider>();

  constructor(providers: SandboxProvider[] = []) {
    for (const provider of providers) this.register(provider);
  }

  register(provider: SandboxProvider): void {
    if (this.providers.has(provider.id))
      throw new Error(`duplicate sandbox provider: ${provider.id}`);
    this.providers.set(provider.id, provider);
  }

  require(id: string): SandboxProvider {
    const provider = this.providers.get(id);
    if (!provider) throw new Error(`unknown sandbox provider: ${id}`);
    return provider;
  }

  list(): SandboxProvider[] {
    return [...this.providers.values()];
  }
}

/** Per-call ceilings the agent tool asks of a sandbox; providers clamp further to their own caps. */
export const SANDBOX_TOOL_LIMITS = { timeoutMs: 5_000, maxOutputBytes: 64 * 1024 } as const;

/** Provider-facing tool names must fit `^[a-zA-Z0-9_-]{1,64}$` for every model API. */
export function sandboxToolName(sandboxId: string): string {
  return `run_code_${sandboxId.replace(/[^a-zA-Z0-9_-]/g, '_')}`.slice(0, 64);
}

function parseSandboxArguments(arguments_: unknown): {
  code: string;
  files?: Record<string, string>;
} {
  if (!arguments_ || typeof arguments_ !== 'object') throw new Error('sandbox tool needs { code }');
  const { code, files } = arguments_ as { code?: unknown; files?: unknown };
  if (typeof code !== 'string' || code.length === 0)
    throw new Error('sandbox tool needs a code string');
  if (files === undefined) return { code };
  if (
    !files ||
    typeof files !== 'object' ||
    Array.isArray(files) ||
    Object.values(files).some((value) => typeof value !== 'string')
  ) {
    throw new Error('sandbox tool files must map names to strings');
  }
  return { code, files: files as Record<string, string> };
}

/** Expose each `sandbox` tool source as one `run_code_<id>` tool backed by a registered provider. */
export function createSandboxToolSourceAdapter(
  registry: SandboxRegistry,
  limits: { timeoutMs: number; maxOutputBytes: number } = SANDBOX_TOOL_LIMITS
): AgentToolSourceAdapter {
  return {
    kind: 'sandbox',
    assertSource(source) {
      if (source.kind === 'sandbox') registry.require(source.sandboxId);
    },
    async resolve(source) {
      if (source.kind !== 'sandbox') {
        throw new Error(`sandbox adapter cannot resolve ${source.kind} tools`);
      }
      const provider = registry.require(source.sandboxId);
      const language = provider.languages?.[0] ?? 'javascript';
      return [
        {
          definition: {
            name: sandboxToolName(provider.id),
            description:
              `Run ${language} in an isolated sandbox (${provider.id}) with no network or filesystem. ` +
              'Print results with console.log; read inputs from the global `files` object. ' +
              'Returns exitCode, stdout and stderr.',
            inputSchema: {
              type: 'object',
              properties: {
                code: { type: 'string', description: `${language} source to run` },
                files: {
                  type: 'object',
                  additionalProperties: { type: 'string' },
                  description: 'Optional read-only text inputs, exposed as globalThis.files',
                },
              },
              required: ['code'],
              additionalProperties: false,
            },
          },
          permissionClass: provider.permissionClass ?? 'process',
          async execute(arguments_, { signal }) {
            const input = parseSandboxArguments(arguments_);
            const result = await provider.execute(
              {
                language,
                code: input.code,
                ...(input.files ? { files: input.files } : {}),
                timeoutMs: limits.timeoutMs,
                network: 'disabled',
                maxOutputBytes: limits.maxOutputBytes,
              },
              signal
            );
            return [{ type: 'json', value: result }];
          },
        },
      ];
    },
  };
}
