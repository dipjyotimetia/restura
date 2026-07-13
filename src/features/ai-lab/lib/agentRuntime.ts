import {
  AgentRunner,
  AgentSuiteRunner,
  CallbackProviderAdapter,
  ProviderRegistry,
  type AgentSuite,
  type AgentSuiteReport,
  type JudgeFailure,
  type JudgeModelVote,
  type GenerationMessage,
  aggregateJudgeVotes,
} from '@shared/agent-lab';
import type { CompletionResult } from '@shared/protocol/ai/types';
import type { AiLabProviderConfig } from '../types';
import { capabilitiesForDesktopModel, knownCostForCompletion } from './agentModelCapabilities';
import { resolveResturaAgentTools } from './agentTools';
import { completeLlm, specFor, type LlmCallSpec } from './llmClient';

type Complete = (spec: LlmCallSpec) => Promise<CompletionResult>;

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
          async generate(request) {
            const completion = await complete(
              specFor(config, request.model.model, text(request.messages), {
                ...(request.maxOutputTokens ? { maxOutputTokens: request.maxOutputTokens } : {}),
                ...(request.tools ? { tools: request.tools } : {}),
              })
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
  } = {}
): Promise<AgentSuiteReport> {
  const providers = createDesktopAgentProviders(configs, options.complete ?? completeLlm);
  const runner = new AgentRunner({
    providers,
    async resolveCredential() {
      return undefined;
    },
    resolveTools: resolveResturaAgentTools,
    ...(options.requestApproval ? { requestApproval: options.requestApproval } : {}),
  });
  return new AgentSuiteRunner({
    run: (request) => runner.run(request),
    async judge(grader, context) {
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
                structuredOutput: responseSchema,
              },
              {
                async resolveCredential() {
                  return undefined;
                },
              }
            );
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
                error: errorMessage(entry.reason),
              },
            ]
          : []
      );
      const quorum = grader.minimumQuorum ?? Math.floor(grader.judgeModels.length / 2) + 1;
      const panelDetail = `${votes.length}/${grader.judgeModels.length} judges succeeded (quorum ${quorum})`;
      if (votes.length < quorum) {
        return {
          graderId: grader.id,
          kind: grader.kind,
          passed: false,
          detail: `insufficient judge quorum: ${panelDetail}`,
          judgeVotes: votes,
          judgeFailures: failures,
          minimumQuorum: quorum,
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
      };
    },
  }).run({ suite });
}
