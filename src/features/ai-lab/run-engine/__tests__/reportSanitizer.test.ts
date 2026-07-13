import { describe, expect, it } from 'vitest';
import { AiLabReportEnvelopeSchema, type AiLabReportEnvelope } from '../reportEnvelope';
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

  it('removes arbitrary URL credentials and fragments', () => {
    const envelope = agentEnvelope(
      'https://arbitrary-user:arbitrary-password@example.test/path?safe=value#private-fragment'
    );

    const serialized = JSON.stringify(sanitizeAgentSuiteReportForPersistence(envelope));

    expect(serialized).not.toContain('arbitrary-user');
    expect(serialized).not.toContain('arbitrary-password');
    expect(serialized).not.toContain('private-fragment');
    expect(serialized).not.toContain('value');
    expect(serialized).toContain('https://example.test/path');
  });

  it('redacts uppercase HTTP URLs and every URI-backed content block without leaking opaque payloads', () => {
    const envelope = agentEnvelope(
      'HTTPS://upper-user:upper-password@example.test/path?apiKey=upper-secret#upper-fragment'
    );
    envelope.suite.tasks[0]!.input = [
      {
        type: 'image',
        mimeType: 'image/png',
        uri: 'HTTP://media-user:media-password@example.test/image?sig=media-secret#media-fragment',
      },
      {
        type: 'audio',
        mimeType: 'audio/wav',
        uri: 'data:audio/wav;base64,opaque-audio-secret',
      },
      {
        type: 'document',
        mimeType: 'application/pdf',
        uri: 'blob:https://example.test/opaque-blob-secret',
      },
    ];
    envelope.payload.results = [
      {
        taskId: 'task',
        agentId: 'agent',
        trial: 1,
        status: 'passed',
        output: [
          {
            type: 'document',
            mimeType: 'application/pdf',
            uri: 'vault:opaque-document-secret',
          },
        ],
        trace: {
          id: 'trace',
          suiteId: 'suite',
          taskId: 'task',
          trial: 1,
          agentId: 'agent',
          startedAt: 1,
          events: [],
        },
        scores: [],
      },
    ];

    const serialized = JSON.stringify(sanitizeAgentSuiteReportForPersistence(envelope));

    for (const secret of [
      'upper-user',
      'upper-password',
      'upper-secret',
      'upper-fragment',
      'media-user',
      'media-password',
      'media-secret',
      'media-fragment',
      'opaque-audio-secret',
      'opaque-blob-secret',
      'opaque-document-secret',
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain('https://example.test/path');
    expect(serialized).toContain('data:audio/wav;base64,[REDACTED]');
    expect(serialized).toContain('[REDACTED BLOB URI]');
    expect(serialized).toContain('vault:[REDACTED]');
  });

  it.each([
    ['leading spaces', '   data:text/plain,space-prefixed-secret', 'data:text/plain,[REDACTED]'],
    ['leading tab', '\tblob:https://example.test/tab-prefixed-secret', '[REDACTED BLOB URI]'],
    [
      'leading Unicode whitespace',
      '\u00a0data:text/plain,unicode-prefixed-secret',
      'data:text/plain,[REDACTED]',
    ],
    [
      'malformed data URI',
      ' data:text/malformed-secret-without-comma',
      'data:[REDACTED INVALID URI]',
    ],
    [
      'leading newline',
      '\nHTTP://user:password@example.test/path?token=newline-secret',
      'http://example.test/path',
    ],
    ['leading controls', '\u0000\u001fvault:control-prefixed-secret', 'vault:[REDACTED]'],
  ])(
    'classifies %s before URI redaction and keeps the report schema-valid',
    (_label, uri, marker) => {
      const envelope = agentEnvelope('safe');
      envelope.suite.tasks[0]!.input = [{ type: 'document', mimeType: 'text/plain', uri }];

      const sanitized = sanitizeAgentSuiteReportForPersistence(envelope);
      const serialized = JSON.stringify(sanitized);

      expect(serialized).not.toContain('prefixed-secret');
      expect(serialized).not.toContain('newline-secret');
      expect(serialized).not.toContain('malformed-secret');
      expect(serialized).toContain(marker);
      expect(AiLabReportEnvelopeSchema.safeParse(sanitized).success).toBe(true);
    }
  );

  it('preserves resource token counters and round-trips through the report schema', () => {
    const envelope = agentEnvelope('safe');
    envelope.payload.results = [
      {
        taskId: 'task',
        agentId: 'agent',
        trial: 1,
        status: 'passed',
        output: [],
        trace: {
          id: 'trace',
          suiteId: 'suite',
          taskId: 'task',
          trial: 1,
          agentId: 'agent',
          startedAt: 1,
          events: [],
        },
        scores: [
          {
            graderId: 'judge',
            kind: 'judge',
            passed: true,
            usage: { inputTokens: 12, outputTokens: 4 },
            resourceCalls: { attempted: 3, usageKnown: 2, costKnown: 1 },
          },
        ],
      },
    ];
    envelope.suite.agents[0]!.limits.maxTokens = 123;

    const sanitized = sanitizeAgentSuiteReportForPersistence(envelope);

    expect(sanitized.payload.results[0]!.scores[0]!.usage).toEqual({
      inputTokens: 12,
      outputTokens: 4,
    });
    expect(sanitized.suite.agents[0]!.limits.maxTokens).toBe(123);
    expect(AiLabReportEnvelopeSchema.parse(sanitized)).toEqual(sanitized);
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
