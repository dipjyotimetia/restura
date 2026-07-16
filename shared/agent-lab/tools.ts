import type { AgentTool, PermissionClass } from './runner';
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
  return descriptors
    .filter((tool) => !allowed || allowed.has(tool.name))
    .map((tool) => ({
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
