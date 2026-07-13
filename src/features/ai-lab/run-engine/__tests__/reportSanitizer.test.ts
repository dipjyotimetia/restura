import { describe, expect, it } from 'vitest';
import type { AiLabReportEnvelope } from '../reportEnvelope';
import {
  AgentReportTooLargeError,
  retainAgentReports,
  sanitizeAgentSuiteReportForPersistence,
} from '../reportSanitizer';

function agentEnvelope(text: string): Extract<AiLabReportEnvelope, { kind: 'agent-suite' }> {
  return {
    id: 'report',
    kind: 'agent-suite',
    name: 'suite',
    startedAt: 1,
    finishedAt: 2,
    status: 'passed',
    suite: {
      schemaVersion: 2,
      id: 'suite',
      name: 'suite',
      mode: 'regression',
      agents: [
        {
          id: 'agent',
          model: { providerId: 'p', model: 'm' },
          instructions: text,
          tools: [],
          limits: { maxSteps: 1, maxWallTimeMs: 1000 },
        },
      ],
      tasks: [{ id: 'task', input: [{ type: 'text', text }] }],
      graders: [],
      trials: 1,
    },
    payload: {
      suiteId: 'suite',
      status: 'passed',
      results: [],
      summary: {
        total: 0,
        passed: 0,
        failed: 0,
        errors: 0,
        cancelled: 0,
        passRate: 0,
        confidence95: { low: 0, high: 0 },
        passAtK: {},
        passToK: {},
        reliabilityByCase: [],
      },
    },
  };
}

describe('agent report persistence sanitization', () => {
  it('redacts recursive secrets, credential headers, query values, and token-shaped bodies', () => {
    const envelope = agentEnvelope('Bearer sk-supersecret https://x.test/a?token=secret');
    (envelope.payload as unknown as { debug: unknown }).debug = {
      authorization: 'Bearer raw',
      headers: { Authorization: 'Bearer raw', Accept: 'json' },
      password: 'raw',
    };
    const serialized = JSON.stringify(sanitizeAgentSuiteReportForPersistence(envelope));
    expect(serialized).not.toContain('supersecret');
    expect(serialized).not.toContain('Bearer raw');
    expect(serialized).not.toContain('"password":"raw"');
    expect(serialized).toContain('[REDACTED]');
  });

  it('truncates large content with an explicit marker and refuses an irreducibly oversized report', () => {
    const sanitized = sanitizeAgentSuiteReportForPersistence(agentEnvelope('x'.repeat(100_000)));
    expect(JSON.stringify(sanitized)).toContain('[TRUNCATED');

    const impossible = agentEnvelope('small');
    impossible.payload.summary.passAtK = Object.fromEntries(
      Array.from({ length: 180_000 }, (_, index) => [index, index])
    );
    expect(() => sanitizeAgentSuiteReportForPersistence(impossible)).toThrow(
      AgentReportTooLargeError
    );
  });

  it('retains at most 20 reports and evicts oldest deterministically', () => {
    const reports = Object.fromEntries(
      Array.from({ length: 25 }, (_, index) => {
        const report = agentEnvelope('safe');
        report.id = `r-${String(index).padStart(2, '0')}`;
        report.startedAt = index;
        return [report.id, report];
      })
    );
    const retained = retainAgentReports(reports);
    expect(Object.keys(retained)).toHaveLength(20);
    expect(retained['r-24']).toBeDefined();
    expect(retained['r-00']).toBeUndefined();
  });
});
