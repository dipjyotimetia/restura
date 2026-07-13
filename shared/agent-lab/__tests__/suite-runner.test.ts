import { describe, expect, it } from 'vitest';
import type { AgentRunResult } from '../runner';
import type { AgentSuite } from '../types';
import { AgentSuiteRunner } from '../suite-runner';

const suite: AgentSuite = {
  schemaVersion: 2,
  id: 'suite',
  name: 'Reliability',
  mode: 'regression',
  trials: 3,
  agents: [
    {
      id: 'agent',
      model: { providerId: 'fake', model: 'm' },
      instructions: 'answer',
      tools: [],
      limits: { maxSteps: 2, maxWallTimeMs: 1_000 },
    },
  ],
  tasks: [{ id: 'task', input: [{ type: 'text', text: 'ping' }] }],
  graders: [
    { id: 'contains', kind: 'contains', value: 'pong' },
    { id: 'latency', kind: 'latency', maxMs: 100 },
  ],
};

function result(trial: number, output: string): AgentRunResult {
  return {
    status: 'passed',
    output: [{ type: 'text', text: output }],
    trace: {
      id: `trace-${trial}`,
      suiteId: 'suite',
      taskId: 'task',
      trial,
      agentId: 'agent',
      startedAt: 0,
      finishedAt: 50,
      events: [],
    },
  };
}

describe('AgentSuiteRunner', () => {
  it('grades each task against its own reference while preserving literal graders', async () => {
    const referenceSuite = {
      ...suite,
      trials: 1,
      tasks: [
        {
          id: 'task-a',
          input: [{ type: 'text', text: 'A' }],
          reference: [{ type: 'text', text: 'alpha' }],
        },
        {
          id: 'task-b',
          input: [{ type: 'text', text: 'B' }],
          reference: [{ type: 'text', text: 'beta' }],
        },
      ],
      graders: [
        { id: 'reference', kind: 'exact' },
        { id: 'literal', kind: 'contains', value: 'a' },
      ],
    } as unknown as AgentSuite;
    const outputs = ['alpha', 'beta'];
    let index = 0;
    const runner = new AgentSuiteRunner({
      async run(request) {
        const run = result(request.trial, outputs[index++]!);
        run.trace.taskId = request.taskId;
        return run;
      },
    });

    const report = await runner.run({ suite: referenceSuite });

    expect(report.results.map((trial) => trial.scores[0]?.passed)).toEqual([true, true]);
    expect(report.results.map((trial) => trial.scores[1]?.passed)).toEqual([true, true]);
  });

  it('passes the current task grading context to judge graders', async () => {
    const judgeSuite = {
      ...suite,
      trials: 1,
      tasks: [
        {
          id: 'task',
          input: [{ type: 'text', text: 'question' }],
          reference: [{ type: 'text', text: 'answer' }],
        },
      ],
      graders: [
        {
          id: 'judge',
          kind: 'judge',
          judgeModels: [{ providerId: 'judge', model: 'model' }],
          rubric: 'Correctness',
          labels: ['pass', 'fail'],
          minimumAgreement: 0.5,
          calibrated: false,
        },
      ],
    } as AgentSuite;
    const runner = new AgentSuiteRunner({
      async run(request) {
        return result(request.trial, 'candidate');
      },
      async judge(_grader, context) {
        expect(context).toMatchObject({
          inputText: 'question',
          reference: 'answer',
          outputText: 'candidate',
        });
        expect(context.task.id).toBe('task');
        expect(context.result.output).toEqual([{ type: 'text', text: 'candidate' }]);
        return { graderId: 'judge', kind: 'judge', passed: true };
      },
    });

    const report = await runner.run({ suite: judgeSuite });

    expect(report.results[0]?.scores[0]?.passed).toBe(true);
  });

  it('serializes grading blocks canonically without collapsing boundaries or raw media', async () => {
    const mediaSecret = 'data:image/png;base64,SECRET_BYTES';
    const structuredSuite = {
      ...suite,
      trials: 1,
      tasks: [
        {
          id: 'task',
          input: [
            { type: 'text', text: 'first' },
            { type: 'reasoning-summary', text: 'second' },
            { type: 'json', value: { z: 1, a: 2 } },
          ],
          reference: [{ type: 'image', mimeType: 'image/png', data: mediaSecret, name: 'sample' }],
        },
      ],
      graders: [
        {
          id: 'judge',
          kind: 'judge',
          judgeModels: [{ providerId: 'judge', model: 'model' }],
          rubric: 'Correctness',
          labels: ['pass', 'fail'],
          minimumAgreement: 0.5,
          calibrated: false,
        },
      ],
    } as AgentSuite;
    const runner = new AgentSuiteRunner({
      async run(request) {
        const run = result(request.trial, 'ignored');
        run.output = [
          { type: 'document', mimeType: 'application/pdf', uri: 'https://secret.example/token' },
          { type: 'artifact', artifactId: 'report', name: 'Report' },
          { type: 'json', value: { b: 2, a: 1 } },
        ];
        return run;
      },
      async judge(_grader, context) {
        expect(context.inputText).toBe('first\n[reasoning-summary] second\n[json] {"a":2,"z":1}');
        expect(context.reference).toContain('[image]');
        expect(context.reference).not.toContain('SECRET_BYTES');
        expect(context.outputText).toContain('[document]');
        expect(context.outputText).toContain('[artifact]');
        expect(context.outputText).toContain('[json] {"a":1,"b":2}');
        expect(context.outputText).not.toContain('secret.example');
        expect(context.reference).not.toBe(context.outputText);
        return { graderId: 'judge', kind: 'judge', passed: true };
      },
    });

    const report = await runner.run({ suite: structuredSuite });

    expect(report.results[0]?.scores[0]?.passed).toBe(true);
  });

  it('fails reference-backed exact and contains graders for unusable serialized references', async () => {
    const emptyReferenceSuite = {
      ...suite,
      trials: 1,
      tasks: [
        {
          id: 'task',
          input: [{ type: 'text', text: 'question' }],
          reference: [{ type: 'text', text: '   ' }],
        },
      ],
      graders: [
        { id: 'exact', kind: 'exact' },
        { id: 'contains', kind: 'contains' },
      ],
    } as unknown as AgentSuite;
    const runner = new AgentSuiteRunner({
      async run(request) {
        return result(request.trial, 'candidate');
      },
    });

    const report = await runner.run({ suite: emptyReferenceSuite });

    expect(report.results[0]?.scores).toEqual([
      expect.objectContaining({ passed: false, detail: 'task reference has no gradable content' }),
      expect.objectContaining({ passed: false, detail: 'task reference has no gradable content' }),
    ]);
  });

  it('cancels grading sequentially and does not start later graders', async () => {
    const controller = new AbortController();
    const gradingSuite = {
      ...suite,
      trials: 1,
      graders: [
        {
          id: 'judge-1',
          kind: 'judge',
          judgeModels: [{ providerId: 'judge', model: 'one' }],
          rubric: 'Correctness',
          labels: ['pass', 'fail'],
          minimumAgreement: 0.5,
          calibrated: false,
        },
        {
          id: 'judge-2',
          kind: 'judge',
          judgeModels: [{ providerId: 'judge', model: 'two' }],
          rubric: 'Correctness',
          labels: ['pass', 'fail'],
          minimumAgreement: 0.5,
          calibrated: false,
        },
      ],
    } as AgentSuite;
    const graders: string[] = [];
    const runner = new AgentSuiteRunner({
      async run(request) {
        return result(request.trial, 'candidate');
      },
      async judge(grader, context) {
        graders.push(grader.id);
        expect(context.signal).toBe(controller.signal);
        controller.abort();
        throw new DOMException('cancelled', 'AbortError');
      },
    });

    const report = await runner.run({ suite: gradingSuite, signal: controller.signal });

    expect(graders).toEqual(['judge-1']);
    expect(report.status).toBe('cancelled');
    expect(report.results[0]?.status).toBe('cancelled');
  });

  it('runs repeated trials and reports reliability separately from errors', async () => {
    const outputs = ['pong', 'nope', 'pong'];
    const runner = new AgentSuiteRunner({
      async run(request) {
        return result(request.trial, outputs[request.trial - 1]!);
      },
    });
    const report = await runner.run({ suite });
    expect(report.status).toBe('failed');
    expect(report.summary).toMatchObject({
      total: 3,
      passed: 2,
      failed: 1,
      errors: 0,
      passRate: 2 / 3,
    });
    expect(report.summary.passAtK[1]).toBeCloseTo(2 / 3);
    expect(report.summary.passAtK[2]).toBe(1);
    expect(report.summary.passToK[2]).toBeCloseTo(1 / 3);
    expect(report.results[1]?.scores.find((score) => score.graderId === 'contains')?.passed).toBe(
      false
    );
    expect(report.summary.reliabilityByCase).toHaveLength(1);
  });

  it('stops all remaining tasks when cancelled', async () => {
    const controller = new AbortController();
    const multi: AgentSuite = {
      ...suite,
      tasks: [...suite.tasks, { id: 'task-2', input: [{ type: 'text', text: 'two' }] }],
    };
    let calls = 0;
    const runner = new AgentSuiteRunner({
      async run(request) {
        calls += 1;
        controller.abort();
        return result(request.trial, 'pong');
      },
    });
    const report = await runner.run({ suite: multi, signal: controller.signal });
    expect(calls).toBe(1);
    expect(report.status).toBe('cancelled');
  });

  it('fails cost grading when provider pricing is unknown', async () => {
    const costSuite: AgentSuite = {
      ...suite,
      trials: 1,
      graders: [{ id: 'cost', kind: 'cost', maxUSD: 0 }],
    };
    const runner = new AgentSuiteRunner({
      async run(request) {
        return result(request.trial, 'pong');
      },
    });
    const report = await runner.run({ suite: costSuite });
    expect(report.results[0]?.scores[0]).toMatchObject({
      passed: false,
      detail: 'cost unknown for one or more model calls',
    });
  });
});
