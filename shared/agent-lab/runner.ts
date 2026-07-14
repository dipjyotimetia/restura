import Ajv, { type ValidateFunction } from 'ajv';
import {
  type AgentToolDefinition,
  type GenerationMessage,
  type GenerationResponse,
  type ProviderRegistry,
  validateGenerationRequest,
} from './provider';
import { TraceEventSchema } from './schema';
import type {
  AgentDefinition,
  AgentSuite,
  ContentBlock,
  CredentialRef,
  ToolSource,
  Trace,
  TraceEvent,
} from './types';

export type PermissionClass =
  'read' | 'network' | 'mutation' | 'credential' | 'filesystem' | 'process' | 'destructive';

export interface AgentTool {
  definition: AgentToolDefinition;
  permissionClass: PermissionClass;
  execute(arguments_: unknown, context: { signal: AbortSignal }): Promise<ContentBlock[]>;
}

export interface ApprovalRequest {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  arguments: unknown;
  permissionClass: PermissionClass;
}

export interface AgentRunnerDependencies {
  providers: ProviderRegistry;
  resolveTools(sources: ToolSource[]): Promise<AgentTool[]>;
  resolveCredential(ref: CredentialRef | undefined): Promise<string | undefined>;
  requestApproval?(request: ApprovalRequest): Promise<'approved' | 'denied'>;
  now?(): number;
  id?(): string;
}

export interface AgentRunRequest {
  suite: AgentSuite;
  taskId: string;
  agentId: string;
  trial: number;
  signal?: AbortSignal;
}

export interface AgentRunResult {
  status: 'passed' | 'failed' | 'error' | 'cancelled';
  output: ContentBlock[];
  trace: Trace;
  error?: string;
}

type TraceEventInput = TraceEvent extends infer Event
  ? Event extends TraceEvent
    ? Omit<Event, 'id' | 'traceId' | 'sequence' | 'timestamp'>
    : never
  : never;

function outputBytes(blocks: ContentBlock[]): number {
  return new TextEncoder().encode(JSON.stringify(blocks)).byteLength;
}

function serializedBytes(value: unknown): number {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? 0 : new TextEncoder().encode(serialized).byteLength;
}

function messageInput(messages: GenerationMessage[]): ContentBlock[] {
  return messages.flatMap((message) => message.content);
}

function requiresApproval(permissionClass: PermissionClass): boolean {
  return permissionClass !== 'read';
}

function isValidTokenUsage(usage: unknown): usage is NonNullable<GenerationResponse['usage']> {
  if (typeof usage !== 'object' || usage === null) return false;
  const candidate = usage as Record<string, unknown>;
  return [candidate.inputTokens, candidate.outputTokens].every(
    (tokens) =>
      typeof tokens === 'number' &&
      Number.isFinite(tokens) &&
      Number.isInteger(tokens) &&
      tokens >= 0
  );
}

export class AgentRunner {
  private readonly now: () => number;
  private readonly id: () => string;

  constructor(private readonly dependencies: AgentRunnerDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.id = dependencies.id ?? (() => crypto.randomUUID());
  }

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    const { suite, taskId, agentId, trial } = request;
    const task = suite.tasks.find((candidate) => candidate.id === taskId);
    const agent = suite.agents.find((candidate) => candidate.id === agentId);
    if (!task) throw new Error(`unknown task: ${taskId}`);
    if (!agent) throw new Error(`unknown agent: ${agentId}`);

    const startedAt = this.now();
    const trace: Trace = {
      id: this.id(),
      suiteId: suite.id,
      taskId,
      trial,
      agentId,
      startedAt,
      events: [],
    };
    const emit = (event: TraceEventInput): void => {
      trace.events.push(
        TraceEventSchema.parse({
          ...event,
          id: this.id(),
          traceId: trace.id,
          sequence: trace.events.length,
          timestamp: this.now(),
        })
      );
    };

    emit({ type: 'run.started', agentId });
    let output: ContentBlock[] = [];
    let status: AgentRunResult['status'] = 'error';
    let error: string | undefined;

    try {
      const result = await this.executeAgent(agent, task.input, request.signal, startedAt, emit);
      output = result;
      status = 'passed';
    } catch (cause) {
      status = request.signal?.aborted ? 'cancelled' : 'error';
      error = cause instanceof Error ? cause.message : String(cause);
    }

    trace.finishedAt = this.now();
    emit({ type: 'run.completed', status });
    return error ? { status, output, trace, error } : { status, output, trace };
  }

  private async executeAgent(
    agent: AgentDefinition,
    input: ContentBlock[],
    externalSignal: AbortSignal | undefined,
    startedAt: number,
    emit: (event: TraceEventInput) => void
  ): Promise<ContentBlock[]> {
    const abortController = new AbortController();
    const abort = (): void => abortController.abort(externalSignal?.reason);
    externalSignal?.addEventListener('abort', abort, { once: true });
    if (externalSignal?.aborted) abort();
    let wallTimer: ReturnType<typeof setTimeout>;
    const wallTimeout = new Promise<never>((_resolve, reject) => {
      wallTimer = setTimeout(() => {
        abortController.abort('wall-time limit exceeded');
        reject(new Error(`agent exceeded maxWallTimeMs (${agent.limits.maxWallTimeMs})`));
      }, agent.limits.maxWallTimeMs);
    });
    try {
      const withinWallTime = <Value>(operation: Promise<Value>): Promise<Value> =>
        Promise.race([operation, wallTimeout]);
      const tools = await withinWallTime(this.dependencies.resolveTools(agent.tools));
      const duplicateToolNames = tools
        .map((tool) => tool.definition.name)
        .filter((name, index, names) => names.indexOf(name) !== index);
      if (duplicateToolNames.length) {
        throw new Error(`duplicate resolved tool name: ${duplicateToolNames[0]}`);
      }
      if (agent.handoffs?.length) {
        throw new Error('agent handoffs require a registered handoff runtime');
      }
      const toolsByName = new Map(tools.map((tool) => [tool.definition.name, tool]));
      const ajv = new Ajv({ allErrors: true, strict: false });
      const toolValidators = new Map<string, ValidateFunction>();
      for (const tool of tools) {
        try {
          toolValidators.set(tool.definition.name, ajv.compile(tool.definition.inputSchema));
        } catch (cause) {
          throw new Error(
            `invalid input schema for tool ${tool.definition.name}: ${cause instanceof Error ? cause.message : String(cause)}`
          );
        }
      }
      const provider = this.dependencies.providers.require(agent.model.providerId);
      const capabilities = await withinWallTime(provider.getCapabilities(agent.model.model));
      const messages: GenerationMessage[] = [
        { role: 'system', content: [{ type: 'text', text: agent.instructions }] },
        { role: 'user', content: input },
      ];
      let toolCallCount = 0;
      let totalCostUSD = 0;
      let totalTokens = 0;
      let totalOutputBytes = 0;
      let continuationId: string | undefined;

      for (let step = 0; step < agent.limits.maxSteps; step += 1) {
        this.assertWithinLimits(agent, startedAt, toolCallCount, totalTokens, totalCostUSD);
        if (abortController.signal.aborted) throw new Error('agent run cancelled');
        const remainingTokens =
          agent.limits.maxTokens === undefined ? undefined : agent.limits.maxTokens - totalTokens;
        if (remainingTokens !== undefined && remainingTokens <= 0) {
          throw new Error(`agent exceeded maxTokens (${agent.limits.maxTokens})`);
        }

        const generationRequest = {
          model: agent.model,
          messages,
          tools: tools.map((tool) => tool.definition),
          ...(continuationId ? { continuationId } : {}),
          ...(remainingTokens === undefined ? {} : { maxOutputTokens: remainingTokens }),
        };
        const requestErrors = validateGenerationRequest(generationRequest, capabilities);
        if (requestErrors.length > 0) throw new Error(requestErrors.join('; '));

        emit({
          type: 'model.requested',
          providerId: agent.model.providerId,
          model: agent.model.model,
          input: messageInput(messages),
        });
        const modelStartedAt = this.now();
        let response: GenerationResponse;
        try {
          response = await withinWallTime(
            provider.generate(generationRequest, {
              signal: abortController.signal,
              resolveCredential: (ref) => this.dependencies.resolveCredential(ref),
            })
          );
        } catch (cause) {
          emit({
            type: 'model.failed',
            providerId: agent.model.providerId,
            model: agent.model.model,
            error: cause instanceof Error ? cause.message : String(cause),
            durationMs: this.now() - modelStartedAt,
          });
          throw cause;
        }
        const durationMs = this.now() - modelStartedAt;
        if (agent.limits.maxTokens !== undefined && response.usage === undefined) {
          const usageError = 'agent cannot enforce maxTokens because provider usage is unknown';
          emit({
            type: 'model.failed',
            providerId: agent.model.providerId,
            model: agent.model.model,
            error: usageError,
            durationMs,
          });
          throw new Error(usageError);
        }
        if (agent.limits.maxTokens !== undefined && !isValidTokenUsage(response.usage)) {
          const usageError = 'agent cannot enforce maxTokens because provider usage is invalid';
          emit({
            type: 'model.failed',
            providerId: agent.model.providerId,
            model: agent.model.model,
            error: usageError,
            durationMs,
          });
          throw new Error(usageError);
        }
        const responseTokens =
          (response.usage?.inputTokens ?? 0) + (response.usage?.outputTokens ?? 0);
        if (
          agent.limits.maxTokens !== undefined &&
          (totalTokens + responseTokens > agent.limits.maxTokens ||
            (totalTokens + responseTokens === agent.limits.maxTokens &&
              response.toolCalls.length > 0))
        ) {
          const limitError = `agent exceeded maxTokens (${agent.limits.maxTokens})`;
          emit({
            type: 'model.failed',
            providerId: agent.model.providerId,
            model: agent.model.model,
            error: limitError,
            durationMs,
          });
          throw new Error(limitError);
        }
        // Provider state is retained and replayed on later turns. Count it as well as the
        // normalized output so opaque reasoning/tool state cannot bypass the hard budget.
        const responseBytes =
          outputBytes(response.output) +
          (response.providerState === undefined ? 0 : serializedBytes(response.providerState));
        if (
          agent.limits.maxOutputBytes &&
          totalOutputBytes + responseBytes > agent.limits.maxOutputBytes
        ) {
          const limitError = `agent exceeded maxOutputBytes (${agent.limits.maxOutputBytes})`;
          emit({
            type: 'model.failed',
            providerId: agent.model.providerId,
            model: agent.model.model,
            error: limitError,
            durationMs,
          });
          throw new Error(limitError);
        }
        if (agent.limits.maxCostUSD !== undefined && response.costUSD === undefined) {
          const costError = 'agent cannot enforce maxCostUSD because provider cost is unknown';
          emit({
            type: 'model.failed',
            providerId: agent.model.providerId,
            model: agent.model.model,
            error: costError,
            durationMs,
          });
          throw new Error(costError);
        }
        totalOutputBytes += responseBytes;
        totalCostUSD += response.costUSD ?? 0;
        totalTokens += responseTokens;
        emit({
          type: 'model.completed',
          providerId: agent.model.providerId,
          model: agent.model.model,
          output: response.output,
          durationMs,
          usage: response.usage,
          costUSD: response.costUSD,
        });
        this.assertWithinLimits(agent, startedAt, toolCallCount, totalTokens, totalCostUSD);
        continuationId = capabilities.continuation ? response.continuationId : undefined;

        if (response.toolCalls.length === 0) return response.output;

        messages.push({
          role: 'assistant',
          content: response.output,
          toolCalls: response.toolCalls,
          providerState: response.providerState,
        });
        for (const toolCall of response.toolCalls) {
          toolCallCount += 1;
          this.assertWithinLimits(agent, startedAt, toolCallCount, totalTokens, totalCostUSD);
          const tool = toolsByName.get(toolCall.name);
          if (!tool) throw new Error(`model requested unavailable tool: ${toolCall.name}`);
          const validateArguments = toolValidators.get(toolCall.name)!;
          if (!validateArguments(toolCall.arguments)) {
            const validationError = `invalid arguments for tool ${toolCall.name}: ${ajv.errorsText(validateArguments.errors)}`;
            emit({
              type: 'tool.failed',
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              error: validationError,
              durationMs: 0,
            });
            throw new Error(validationError);
          }
          emit({
            type: 'tool.requested',
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            arguments: toolCall.arguments,
            permissionClass: tool.permissionClass,
          });

          if (requiresApproval(tool.permissionClass)) {
            const approvalId = this.id();
            emit({
              type: 'approval.requested',
              approvalId,
              toolCallId: toolCall.id,
              permissionClass: tool.permissionClass,
            });
            const decision = this.dependencies.requestApproval
              ? await withinWallTime(
                  this.dependencies.requestApproval({
                    approvalId,
                    toolCallId: toolCall.id,
                    toolName: toolCall.name,
                    arguments: toolCall.arguments,
                    permissionClass: tool.permissionClass,
                  })
                )
              : 'denied';
            emit({ type: 'approval.resolved', approvalId, decision });
            if (decision === 'denied')
              throw new Error(`approval denied for tool: ${toolCall.name}`);
          }

          const toolStartedAt = this.now();
          try {
            const toolOutput = await withinWallTime(
              tool.execute(toolCall.arguments, { signal: abortController.signal })
            );
            totalOutputBytes += outputBytes(toolOutput);
            if (agent.limits.maxOutputBytes && totalOutputBytes > agent.limits.maxOutputBytes) {
              throw new Error(`agent exceeded maxOutputBytes (${agent.limits.maxOutputBytes})`);
            }
            emit({
              type: 'tool.completed',
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              output: toolOutput,
              durationMs: this.now() - toolStartedAt,
            });
            messages.push({ role: 'tool', toolCallId: toolCall.id, content: toolOutput });
          } catch (cause) {
            const toolError = cause instanceof Error ? cause.message : String(cause);
            emit({
              type: 'tool.failed',
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              error: toolError,
              durationMs: this.now() - toolStartedAt,
            });
            throw new Error(`tool ${toolCall.name} failed: ${toolError}`);
          }
        }
      }
      throw new Error(`agent exceeded maxSteps (${agent.limits.maxSteps})`);
    } finally {
      clearTimeout(wallTimer!);
      externalSignal?.removeEventListener('abort', abort);
    }
  }

  private assertWithinLimits(
    agent: AgentDefinition,
    startedAt: number,
    toolCallCount: number,
    totalTokens: number,
    totalCostUSD: number
  ): void {
    if (this.now() - startedAt > agent.limits.maxWallTimeMs) {
      throw new Error(`agent exceeded maxWallTimeMs (${agent.limits.maxWallTimeMs})`);
    }
    if (agent.limits.maxToolCalls && toolCallCount > agent.limits.maxToolCalls) {
      throw new Error(`agent exceeded maxToolCalls (${agent.limits.maxToolCalls})`);
    }
    if (agent.limits.maxTokens && totalTokens > agent.limits.maxTokens) {
      throw new Error(`agent exceeded maxTokens (${agent.limits.maxTokens})`);
    }
    if (agent.limits.maxCostUSD !== undefined && totalCostUSD > agent.limits.maxCostUSD) {
      throw new Error(`agent exceeded maxCostUSD (${agent.limits.maxCostUSD})`);
    }
  }
}
