import Ajv from 'ajv';
import { passAtK, passToK, scoreTrajectory, wilsonInterval } from './evaluation';
import type { AgentRunRequest, AgentRunResult } from './runner';
import type { AgentSuite, ContentBlock, Grader, Trace } from './types';

export interface GraderScore {
  graderId: string;
  kind: Grader['kind'];
  passed: boolean;
  score?: number;
  detail?: string;
}

export interface SuiteTrialResult {
  taskId: string;
  agentId: string;
  trial: number;
  status: 'passed' | 'failed' | 'error' | 'cancelled';
  output: ContentBlock[];
  trace: Trace;
  scores: GraderScore[];
  error?: string;
}

export interface AgentSuiteReport {
  suiteId: string;
  status: 'passed' | 'failed' | 'error' | 'cancelled';
  results: SuiteTrialResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    errors: number;
    cancelled: number;
    passRate: number;
    confidence95: { low: number; high: number };
    passAtK: Record<number, number>;
    passToK: Record<number, number>;
    reliabilityByCase: Array<{
      agentId: string;
      taskId: string;
      total: number;
      passed: number;
      passRate: number;
      confidence95: { low: number; high: number };
      passAtK: Record<number, number>;
      passToK: Record<number, number>;
    }>;
  };
}

export interface AgentSuiteRunnerDependencies {
  run(request: AgentRunRequest): Promise<AgentRunResult>;
  judge?(grader: Extract<Grader, { kind: 'judge' }>, result: AgentRunResult): Promise<GraderScore>;
}

function asText(blocks: ContentBlock[]): string {
  return blocks
    .map((block) => {
      if (block.type === 'text' || block.type === 'reasoning-summary') return block.text;
      if (block.type === 'refusal') return block.reason;
      if (block.type === 'json') return JSON.stringify(block.value);
      return '';
    })
    .join('');
}

function score(grader: Grader, passed: boolean, detail?: string): GraderScore {
  return { graderId: grader.id, kind: grader.kind, passed, ...(detail ? { detail } : {}) };
}

async function grade(
  grader: Grader,
  result: AgentRunResult,
  judge: AgentSuiteRunnerDependencies['judge']
): Promise<GraderScore> {
  const text = asText(result.output);
  switch (grader.kind) {
    case 'exact':
      return score(grader, text.trim() === grader.value.trim());
    case 'contains':
      return score(grader, text.includes(grader.value));
    case 'regex': {
      try {
        return score(grader, new RegExp(grader.pattern, grader.flags).test(text));
      } catch (cause) {
        return score(
          grader,
          false,
          `invalid regex: ${cause instanceof Error ? cause.message : String(cause)}`
        );
      }
    }
    case 'json-schema': {
      let value: unknown;
      try {
        const json = result.output.find((block) => block.type === 'json');
        value = json?.type === 'json' ? json.value : JSON.parse(text);
        const validate = new Ajv({ allErrors: true, strict: false }).compile(grader.schema);
        const passed = validate(value);
        return score(grader, passed, passed ? undefined : new Ajv().errorsText(validate.errors));
      } catch (cause) {
        return score(
          grader,
          false,
          `JSON grading failed: ${cause instanceof Error ? cause.message : String(cause)}`
        );
      }
    }
    case 'tool': {
      const calls = result.trace.events.filter((event) => event.type === 'tool.requested');
      const matching = grader.toolName
        ? calls.filter((call) => call.toolName === grader.toolName)
        : calls;
      if (matching.length === 0) return score(grader, false, 'expected tool was not called');
      if (!grader.argumentsSchema) return score(grader, true);
      const validate = new Ajv({ allErrors: true, strict: false }).compile(grader.argumentsSchema);
      return score(
        grader,
        matching.some((call) => validate(call.arguments))
      );
    }
    case 'trajectory': {
      const trajectory = scoreTrajectory(result.trace, grader);
      return score(grader, trajectory.passed, trajectory.detail);
    }
    case 'latency': {
      const latency = (result.trace.finishedAt ?? result.trace.startedAt) - result.trace.startedAt;
      return score(grader, latency <= grader.maxMs, `${latency}ms / ${grader.maxMs}ms`);
    }
    case 'cost': {
      const modelEvents = result.trace.events.filter((event) => event.type === 'model.completed');
      if (modelEvents.length === 0 || modelEvents.some((event) => event.costUSD === undefined)) {
        return score(grader, false, 'cost unknown for one or more model calls');
      }
      const cost = modelEvents.reduce((sum, event) => sum + event.costUSD!, 0);
      return score(grader, cost <= grader.maxUSD, `$${cost.toFixed(6)} / $${grader.maxUSD}`);
    }
    case 'judge':
      return judge ? judge(grader, result) : score(grader, false, 'judge runner unavailable');
  }
}

export class AgentSuiteRunner {
  constructor(private readonly dependencies: AgentSuiteRunnerDependencies) {}

  async run(input: { suite: AgentSuite; signal?: AbortSignal }): Promise<AgentSuiteReport> {
    const results: SuiteTrialResult[] = [];
    runLoop: for (const agent of input.suite.agents) {
      for (const task of input.suite.tasks) {
        for (let trial = 1; trial <= input.suite.trials; trial += 1) {
          if (input.signal?.aborted) break runLoop;
          const run = await this.dependencies.run({
            suite: input.suite,
            taskId: task.id,
            agentId: agent.id,
            trial,
            ...(input.signal ? { signal: input.signal } : {}),
          });
          const scores =
            run.status === 'passed'
              ? await Promise.all(
                  input.suite.graders.map(async (grader) => {
                    try {
                      return await grade(grader, run, this.dependencies.judge);
                    } catch (cause) {
                      return score(
                        grader,
                        false,
                        `grader failed: ${cause instanceof Error ? cause.message : String(cause)}`
                      );
                    }
                  })
                )
              : [];
          const status =
            run.status === 'passed' && scores.some((item) => !item.passed) ? 'failed' : run.status;
          results.push({
            taskId: task.id,
            agentId: agent.id,
            trial,
            status,
            output: run.output,
            trace: run.trace,
            scores,
            ...(run.error ? { error: run.error } : {}),
          });
          if (input.signal?.aborted) break runLoop;
        }
      }
    }
    const passed = results.filter((result) => result.status === 'passed').length;
    const failed = results.filter((result) => result.status === 'failed').length;
    const errors = results.filter((result) => result.status === 'error').length;
    const cancelled = results.filter((result) => result.status === 'cancelled').length;
    const total = results.length;
    const grouped = new Map<string, SuiteTrialResult[]>();
    for (const result of results) {
      const key = `${result.agentId}\u0000${result.taskId}`;
      grouped.set(key, [...(grouped.get(key) ?? []), result]);
    }
    const reliabilityByCase = [...grouped.values()].map((group) => {
      const groupPassed = group.filter((result) => result.status === 'passed').length;
      const groupTotal = group.length;
      const groupPassAtK: Record<number, number> = {};
      const groupPassToK: Record<number, number> = {};
      for (let k = 1; k <= groupTotal; k += 1) {
        groupPassAtK[k] = passAtK(groupTotal, groupPassed, k);
        groupPassToK[k] = passToK(groupTotal, groupPassed, k);
      }
      return {
        agentId: group[0]!.agentId,
        taskId: group[0]!.taskId,
        total: groupTotal,
        passed: groupPassed,
        passRate: groupPassed / groupTotal,
        confidence95: wilsonInterval(groupPassed, groupTotal),
        passAtK: groupPassAtK,
        passToK: groupPassToK,
      };
    });
    const maximumK = reliabilityByCase.length
      ? Math.min(input.suite.trials, ...reliabilityByCase.map((group) => group.total))
      : 0;
    const passAtKValues: Record<number, number> = {};
    const passToKValues: Record<number, number> = {};
    for (let k = 1; k <= maximumK; k += 1) {
      passAtKValues[k] =
        reliabilityByCase.reduce((sum, group) => sum + group.passAtK[k]!, 0) /
        reliabilityByCase.length;
      passToKValues[k] =
        reliabilityByCase.reduce((sum, group) => sum + group.passToK[k]!, 0) /
        reliabilityByCase.length;
    }
    const status =
      input.signal?.aborted || cancelled > 0
        ? 'cancelled'
        : errors > 0
          ? 'error'
          : failed > 0
            ? 'failed'
            : 'passed';
    return {
      suiteId: input.suite.id,
      status,
      results,
      summary: {
        total,
        passed,
        failed,
        errors,
        cancelled,
        passRate: total ? passed / total : 0,
        confidence95: wilsonInterval(passed, total),
        passAtK: passAtKValues,
        passToK: passToKValues,
        reliabilityByCase,
      },
    };
  }
}
