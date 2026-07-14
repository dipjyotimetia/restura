import { beforeEach, describe, expect, it } from 'vitest';
import type { WorkflowExecution } from '@/types';
import { useWorkflowStore } from '../useWorkflowStore';

function bigString(len: number, char = 'x'): string {
  return char.repeat(len);
}

function baseExecution(overrides: Partial<WorkflowExecution> = {}): WorkflowExecution {
  return {
    id: 'exec-1',
    workflowId: 'wf-1',
    workflowName: 'test workflow',
    startedAt: Date.now(),
    status: 'success',
    steps: [],
    finalVariables: {},
    executionLog: [],
    ...overrides,
  };
}

describe('useWorkflowStore.saveExecution — persisted size bounds', () => {
  beforeEach(() => {
    useWorkflowStore.setState({ workflows: [], executions: [] });
  });

  it('truncates an oversized step response body', () => {
    const execution = baseExecution({
      steps: [
        {
          nodeId: 'n1',
          requestName: 'req',
          status: 'success',
          timestamp: Date.now(),
          response: {
            id: 'r1',
            requestId: 'req1',
            status: 200,
            statusText: 'OK',
            headers: {},
            body: bigString(200 * 1024),
            size: 200 * 1024,
            time: 10,
            timestamp: Date.now(),
          },
        },
      ],
    });

    useWorkflowStore.getState().saveExecution(execution);
    const saved = useWorkflowStore.getState().executions[0]!;
    expect(saved.steps[0]!.response!.body.length).toBeLessThan(200 * 1024);
    expect(saved.steps[0]!.response!.body).toContain('[truncated');
  });

  it('leaves small response bodies untouched', () => {
    const execution = baseExecution({
      steps: [
        {
          nodeId: 'n1',
          requestName: 'req',
          status: 'success',
          timestamp: Date.now(),
          response: {
            id: 'r1',
            requestId: 'req1',
            status: 200,
            statusText: 'OK',
            headers: {},
            body: '{"ok":true}',
            size: 11,
            time: 1,
            timestamp: Date.now(),
          },
        },
      ],
    });

    useWorkflowStore.getState().saveExecution(execution);
    const saved = useWorkflowStore.getState().executions[0]!;
    expect(saved.steps[0]!.response!.body).toBe('{"ok":true}');
  });

  it('truncates oversized extracted/final variables (e.g. a large sseSubscribe capture)', () => {
    const hugeCapture = bigString(500 * 1024);
    const execution = baseExecution({
      steps: [
        {
          nodeId: 'sse1',
          requestName: 'sseSubscribe',
          status: 'success',
          timestamp: Date.now(),
          extractedVariables: { events: hugeCapture, small: 'ok' },
        },
      ],
      finalVariables: { events: hugeCapture, small: 'ok' },
    });

    useWorkflowStore.getState().saveExecution(execution);
    const saved = useWorkflowStore.getState().executions[0]!;
    expect(saved.steps[0]!.extractedVariables!.events!.length).toBeLessThan(500 * 1024);
    expect(saved.steps[0]!.extractedVariables!.small).toBe('ok');
    expect(saved.finalVariables.events!.length).toBeLessThan(500 * 1024);
    expect(saved.finalVariables.small).toBe('ok');
  });

  it('caps the execution log to the last N entries and truncates long messages', () => {
    const manyLogs = Array.from({ length: 800 }, (_, i) => ({
      timestamp: i,
      message: i === 799 ? bigString(10 * 1024) : `log line ${i}`,
      level: 'info' as const,
    }));
    const execution = baseExecution({ executionLog: manyLogs });

    useWorkflowStore.getState().saveExecution(execution);
    const saved = useWorkflowStore.getState().executions[0]!;
    expect(saved.executionLog.length).toBeLessThanOrEqual(500);
    // The newest entries survive (the huge last message, truncated).
    const last = saved.executionLog[saved.executionLog.length - 1]!;
    expect(last.message.length).toBeLessThan(10 * 1024);
  });

  it('still caps total execution count at 100', () => {
    for (let i = 0; i < 105; i++) {
      useWorkflowStore.getState().saveExecution(baseExecution({ id: `exec-${i}` }));
    }
    expect(useWorkflowStore.getState().executions.length).toBe(100);
  });
});
