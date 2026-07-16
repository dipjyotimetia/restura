import {
  AgentRunner,
  applyAgentBundleBaseline,
  createAgentToolResolver,
  createFixtureToolSourceAdapter,
  type AgentBundle,
  type AgentSuite,
  type AgentSuiteReport,
  AgentSuiteRunner,
  type AgentToolResolver,
  aggregateJudgeVotes,
  CallbackProviderAdapter,
  type GenerationMessage,
  type JudgeFailure,
  type JudgeModelVote,
  type ModelRef,
  ProviderRegistry,
  evaluateAgentBundleBaseline,
  validateGenerationRequest,
} from '@shared/agent-lab';
import type { CompletionResult } from '@shared/protocol/ai/types';
import type { AiLabProviderConfig } from '../types';
import { capabilitiesForDesktopModel, knownCostForCompletion } from './agentModelCapabilities';
import { createResturaRequestToolSourceAdapter } from './agentTools';
import { createMcpAgentToolSourceAdapter } from './agentMcpTools';
import { resolveDesktopGrounding } from './agentGrounding';
import { completeLlm, type LlmCallSpec, specFor } from './llmClient';

type Complete = (
  spec: LlmCallSpec,
  options?: { signal?: AbortSignal }
) => Promise<CompletionResult>;

const DEFAULT_JUDGE_MAX_OUTPUT_TOKENS = 512;

function suiteModelRefs(suite: AgentSuite): Array<{ ref: ModelRef; path: string }> {
  return [
    ...suite.agents.map((agent, index) => ({ ref: agent.model, path: `agents[${index}].model` })),
    ...suite.graders.flatMap((grader, graderIndex) =>
      grader.kind === 'judge'
        ? grader.judgeModels.map((ref, modelIndex) => ({
            ref,
            path: `graders[${graderIndex}].judgeModels[${modelIndex}]`,
          }))
        : []
    ),
  ];
}

/** The desktop callback adapter intentionally resolves endpoint and credentials
 * from the selected AI Lab provider config. Reject portable ModelRef fields it
 * cannot honor so imported suites never silently change execution semantics. */
export function preflightDesktopAgentSuite(suite: AgentSuite): void {
  for (const { ref, path } of suiteModelRefs(suite)) {
    if (ref.credential) {
      throw new Error(
        `Desktop agent runs do not support credential overrides at ${path}; configure credentials on the AI Lab provider configuration`
      );
    }
    if (ref.baseUrl) {
      throw new Error(
        `Desktop agent runs do not support baseUrl overrides at ${path}; configure the endpoint on the AI Lab provider configuration`
      );
    }
    if (ref.parameters && Object.keys(ref.parameters).length > 0) {
      throw new Error(
        `Desktop agent runs do not support ModelRef parameter overrides at ${path}; configure supported run controls in the AI Lab workbench`
      );
    }
  }
}

function capabilityExecutionMetadata(
  suite: AgentSuite,
  configs: Record<string, AiLabProviderConfig>
): NonNullable<AgentSuiteReport['execution']> {
  const unique = new Map<string, ModelRef>();
  for (const { ref } of suiteModelRefs(suite)) {
    unique.set(`${ref.providerId}\u0000${ref.model}`, ref);
  }
  return {
    modelCapabilities: [...unique.values()].map((ref) => {
      const config = configs[ref.providerId];
      if (!config) throw new Error(`unknown provider adapter: ${ref.providerId}`);
      const resolved = capabilitiesForDesktopModel(config, ref.model);
      return {
        providerId: ref.providerId,
        model: ref.model,
        capabilities: resolved.capabilities,
        assertedByUser: resolved.assertedByUser,
        provenance: resolved.provenance,
      };
    }),
  };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function text(messages: GenerationMessage[]): Array<{
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolCalls?: Array<{ id: string; name: string; input: string }>;
}> {
  return messages.map((message) => ({
    role: message.role,
    content: message.content
      .map((block) => {
        if (block.type === 'text' || block.type === 'reasoning-summary') return block.text;
        if (block.type === 'json') return JSON.stringify(block.value);
        if (block.type === 'refusal') return block.reason;
        return `[${block.type}]`;
      })
      .join('\n'),
    ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
    ...(message.toolCalls
      ? {
          toolCalls: message.toolCalls.map((call) => ({
            id: call.id,
            name: call.name,
            input:
              typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments),
          })),
        }
      : {}),
  }));
}

export function createDesktopAgentProviders(
  configs: Record<string, AiLabProviderConfig>,
  complete: Complete = completeLlm
): ProviderRegistry {
  return new ProviderRegistry(
    Object.values(configs).map(
      (config) =>
        new CallbackProviderAdapter({
          id: config.id,
          capabilities: async (model) => capabilitiesForDesktopModel(config, model).capabilities,
          async discoverModels() {
            return config.models.map((id) => ({
              id,
              capabilities: capabilitiesForDesktopModel(config, id).capabilities,
            }));
          },
          async generate(request, context) {
            const capabilities = capabilitiesForDesktopModel(
              config,
              request.model.model
            ).capabilities;
            const unsupported = validateGenerationRequest(request, capabilities);
            if (unsupported.length > 0) throw new Error(unsupported.join('; '));
            const completion = await complete(
              specFor(config, request.model.model, text(request.messages), {
                ...(request.maxOutputTokens !== undefined
                  ? { maxOutputTokens: request.maxOutputTokens }
                  : {}),
                ...(request.tools ? { tools: request.tools } : {}),
              }),
              context.signal ? { signal: context.signal } : {}
            );
            if (!completion.ok) throw new Error(completion.error?.message ?? 'model call failed');
            const costUSD = completion.usage
              ? knownCostForCompletion(config, request.model.model, completion.usage)
              : undefined;
            return {
              id: crypto.randomUUID(),
              output: completion.text ? [{ type: 'text', text: completion.text }] : [],
              toolCalls: completion.toolCalls.map((call) => {
                let arguments_: unknown = call.input;
                try {
                  arguments_ = JSON.parse(call.input);
                } catch {
                  /* preserve invalid provider payload */
                }
                return { id: call.id, name: call.name, arguments: arguments_ };
              }),
              ...(completion.usage
                ? {
                    usage: {
                      inputTokens: completion.usage.promptTokens,
                      outputTokens: completion.usage.completionTokens,
                    },
                    ...(costUSD !== undefined ? { costUSD } : {}),
                  }
                : {}),
              stopReason: completion.toolCalls.length ? 'tool-calls' : 'completed',
            };
          },
        })
    )
  );
}

export async function runDesktopAgentSuite(
  suite: AgentSuite,
  configs: Record<string, AiLabProviderConfig>,
  options: {
    requestApproval?: ConstructorParameters<typeof AgentRunner>[0]['requestApproval'];
    complete?: Complete;
    signal?: AbortSignal;
    reportProgress?: (progress: number) => void;
    toolResolver?: AgentToolResolver;
  } = {}
): Promise<AgentSuiteReport> {
  preflightDesktopAgentSuite(suite);
  const toolResolver =
    options.toolResolver ??
    createAgentToolResolver([
      createResturaRequestToolSourceAdapter(),
      createMcpAgentToolSourceAdapter(),
    ]);
  for (const agent of suite.agents) toolResolver.assertSupported(agent.tools);
  const execution = capabilityExecutionMetadata(suite, configs);
  const providers = createDesktopAgentProviders(configs, options.complete ?? completeLlm);
  const runner = new AgentRunner({
    providers,
    async resolveCredential() {
      return undefined;
    },
    resolveTools: (sources, signal) => toolResolver.resolve(sources, signal),
    resolveGrounding: resolveDesktopGrounding,
    ...(options.requestApproval ? { requestApproval: options.requestApproval } : {}),
  });
  const totalTrials = suite.agents.length * suite.tasks.length * suite.trials;
  let completedTrials = 0;
  options.reportProgress?.(0);
  const report = await new AgentSuiteRunner({
    run: async (request) => {
      const result = await runner.run(request);
      completedTrials += 1;
      options.reportProgress?.(totalTrials ? completedTrials / totalTrials : 1);
      return result;
    },
    async judge(grader, context) {
      let attemptedCalls = 0;
      const successfulCalls: Array<{
        usage?: { inputTokens: number; outputTokens: number };
        costUSD?: number;
      }> = [];
      const responseSchema = {
        type: 'object' as const,
        required: ['label', 'score'],
        additionalProperties: false,
        properties: {
          label: { type: 'string' as const, enum: grader.labels },
          score: { type: 'number' as const, minimum: 0, maximum: 1 },
          reasoning: { type: 'string' as const },
        },
      };
      const settled = await Promise.allSettled(
        grader.judgeModels.map(async (model) => {
          const adapter = providers.require(model.providerId);
          const invoke = async (
            candidateOutput: string,
            candidateInput: string,
            candidateReference?: string
          ) => {
            attemptedCalls += 1;
            const response = await adapter.generate(
              {
                model,
                messages: [
                  {
                    role: 'user',
                    content: [
                      {
                        type: 'text',
                        text: [
                          'Act as a strict evaluation judge. Return only JSON with keys label, score, reasoning.',
                          `Allowed labels: ${grader.labels.join(', ')}`,
                          `Rubric: ${grader.rubric}`,
                          `Task input: ${candidateInput}`,
                          candidateReference !== undefined
                            ? `Reference: ${candidateReference}`
                            : '',
                          `Candidate output: ${candidateOutput}`,
                          `Response schema: ${JSON.stringify(responseSchema)}`,
                        ]
                          .filter(Boolean)
                          .join('\n\n'),
                      },
                    ],
                  },
                ],
                maxOutputTokens: grader.maxOutputTokens ?? DEFAULT_JUDGE_MAX_OUTPUT_TOKENS,
              },
              {
                ...(context.signal ? { signal: context.signal } : {}),
                async resolveCredential() {
                  return undefined;
                },
              }
            );
            successfulCalls.push({
              ...(response.usage ? { usage: response.usage } : {}),
              ...(response.costUSD !== undefined ? { costUSD: response.costUSD } : {}),
            });
            const text = response.output.find((block) => block.type === 'text');
            if (text?.type !== 'text') throw new Error('judge returned no JSON text');
            const parsed = JSON.parse(text.text) as {
              label?: unknown;
              score?: unknown;
              reasoning?: unknown;
            };
            if (
              typeof parsed.label !== 'string' ||
              !grader.labels.includes(parsed.label) ||
              typeof parsed.score !== 'number' ||
              !Number.isFinite(parsed.score) ||
              parsed.score < 0 ||
              parsed.score > 1
            )
              throw new Error('judge returned an invalid verdict');
            return {
              label: parsed.label,
              score: parsed.score,
              ...(typeof parsed.reasoning === 'string' ? { reasoning: parsed.reasoning } : {}),
            };
          };

          let calibration = '';
          if (grader.calibrated) {
            if (!grader.anchors || grader.anchors.length < 2) {
              throw new Error('calibrated judge requires at least two anchors');
            }
            const anchorVotes = await Promise.all(
              grader.anchors.map((anchor) => invoke(anchor.output, anchor.input))
            );
            const correct = anchorVotes.filter(
              (vote, index) => vote.label === grader.anchors![index]!.label
            ).length;
            const accuracy = correct / anchorVotes.length;
            const meanAbsoluteError =
              anchorVotes.reduce(
                (sum, vote, index) => sum + Math.abs(vote.score - grader.anchors![index]!.score),
                0
              ) / anchorVotes.length;
            if (accuracy < 0.8 || meanAbsoluteError > 0.25) {
              throw new Error(
                `judge calibration failed (${(accuracy * 100).toFixed(0)}% label accuracy, ${meanAbsoluteError.toFixed(3)} score MAE)`
              );
            }
            calibration = `calibration ${(accuracy * 100).toFixed(0)}%, MAE ${meanAbsoluteError.toFixed(3)}; `;
          }
          const vote = await invoke(context.outputText, context.inputText, context.reference);
          return {
            providerId: model.providerId,
            model: model.model,
            ...vote,
            reasoning: `${calibration}${vote.reasoning ?? ''}`,
          };
        })
      );
      const votes: JudgeModelVote[] = settled.flatMap((entry) =>
        entry.status === 'fulfilled' ? [entry.value] : []
      );
      const failures: JudgeFailure[] = settled.flatMap((entry, index) =>
        entry.status === 'rejected'
          ? [
              {
                providerId: grader.judgeModels[index]!.providerId,
                model: grader.judgeModels[index]!.model,
                error: errorMessage(entry.reason),
              },
            ]
          : []
      );
      const quorum = grader.minimumQuorum ?? Math.floor(grader.judgeModels.length / 2) + 1;
      const panelDetail = `${votes.length}/${grader.judgeModels.length} judges succeeded (quorum ${quorum})`;
      const usageKnown =
        successfulCalls.length > 0 && successfulCalls.every((call) => call.usage !== undefined);
      const usage = usageKnown
        ? successfulCalls.reduce(
            (total, call) => ({
              inputTokens: total.inputTokens + call.usage!.inputTokens,
              outputTokens: total.outputTokens + call.usage!.outputTokens,
            }),
            { inputTokens: 0, outputTokens: 0 }
          )
        : undefined;
      const costKnown =
        attemptedCalls > 0 &&
        successfulCalls.length === attemptedCalls &&
        successfulCalls.every((call) => call.costUSD !== undefined);
      const costUSD = costKnown
        ? successfulCalls.reduce((total, call) => total + call.costUSD!, 0)
        : undefined;
      const resources = {
        ...(usage ? { usage } : {}),
        ...(costUSD !== undefined ? { costUSD } : {}),
        resourceCalls: {
          attempted: attemptedCalls,
          usageKnown: successfulCalls.filter((call) => call.usage !== undefined).length,
          costKnown: successfulCalls.filter((call) => call.costUSD !== undefined).length,
        },
      };
      if (votes.length < quorum) {
        return {
          graderId: grader.id,
          kind: grader.kind,
          passed: false,
          detail: `insufficient judge quorum: ${panelDetail}`,
          judgeVotes: votes,
          judgeFailures: failures,
          minimumQuorum: quorum,
          ...resources,
        };
      }
      if (grader.maxPanelCostUSD !== undefined && costUSD === undefined) {
        return {
          graderId: grader.id,
          kind: grader.kind,
          passed: false,
          detail: `judge panel cost unknown; cannot enforce $${grader.maxPanelCostUSD} limit; ${panelDetail}`,
          judgeVotes: votes,
          judgeFailures: failures,
          minimumQuorum: quorum,
          ...resources,
        };
      }
      if (grader.maxPanelCostUSD !== undefined && costUSD! > grader.maxPanelCostUSD) {
        return {
          graderId: grader.id,
          kind: grader.kind,
          passed: false,
          detail: `judge panel cost exceeded: $${costUSD!.toFixed(6)} / $${grader.maxPanelCostUSD}; ${panelDetail}`,
          judgeVotes: votes,
          judgeFailures: failures,
          minimumQuorum: quorum,
          ...resources,
        };
      }
      let verdict;
      try {
        verdict = aggregateJudgeVotes(votes);
      } catch (cause) {
        return {
          graderId: grader.id,
          kind: grader.kind,
          passed: false,
          detail: `judge aggregation failed: ${errorMessage(cause)}; ${panelDetail}`,
          judgeVotes: votes,
          judgeFailures: failures,
          minimumQuorum: quorum,
          ...resources,
        };
      }
      const passing = grader.passingLabels ?? [grader.labels[0]!];
      const passed =
        passing.includes(verdict.label) && verdict.agreement >= grader.minimumAgreement;
      return {
        graderId: grader.id,
        kind: grader.kind,
        passed,
        score: verdict.score,
        detail: `${verdict.label} · ${(verdict.agreement * 100).toFixed(0)}% panel agreement · ${panelDetail}`,
        judgeVotes: votes,
        judgeFailures: failures,
        minimumQuorum: quorum,
        ...resources,
      };
    },
  }).run({ suite, ...(options.signal ? { signal: options.signal } : {}) });
  if (!options.signal?.aborted) options.reportProgress?.(1);
  return { ...report, execution };
}

export async function runDesktopAgentBundle(
  bundle: AgentBundle,
  configs: Record<string, AiLabProviderConfig>,
  options: Omit<Parameters<typeof runDesktopAgentSuite>[2], 'toolResolver'> = {}
): Promise<{ report: AgentSuiteReport; gates: ReturnType<typeof evaluateAgentBundleBaseline> }> {
  const toolResolver = createAgentToolResolver([
    createFixtureToolSourceAdapter(bundle.fixtures),
    createResturaRequestToolSourceAdapter(),
    createMcpAgentToolSourceAdapter(),
  ]);
  const report = await runDesktopAgentSuite(bundle.suite, configs, {
    ...options,
    toolResolver,
  });
  const gates = evaluateAgentBundleBaseline(bundle, report);
  return { report: applyAgentBundleBaseline(report, gates), gates };
}
