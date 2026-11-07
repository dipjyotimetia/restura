import { beforeEach, describe, expect, it } from 'vitest';
import { useConsoleStore } from '@/store/useConsoleStore';
import type { GrpcRequest, GrpcResponse } from '@/types';
import { mirrorGrpcCallToConsole } from '../grpcConsoleMirror';

const request = (patch: Partial<GrpcRequest> = {}): GrpcRequest => ({
  id: 'r1',
  name: 'Greet',
  type: 'grpc',
  methodType: 'unary',
  url: 'grpc://localhost:50051',
  service: 'greet.v1.Greeter',
  method: 'SayHello',
  metadata: [
    { id: 'm1', key: 'x-trace', value: 'abc', enabled: true },
    { id: 'm2', key: 'x-off', value: 'nope', enabled: false },
    { id: 'm3', key: '', value: 'blank', enabled: true },
  ],
  message: '{"name":"ada"}',
  auth: { type: 'none' },
  ...patch,
});

const response: GrpcResponse = {
  id: 'resp',
  requestId: 'r1',
  status: 0,
  statusText: 'OK',
  headers: {},
  body: '{"message":"hi"}',
  size: 16,
  time: 5,
  timestamp: 1,
  grpcStatus: 0,
};

const log = (message: string) => ({ type: 'log' as const, message, timestamp: 1 });

beforeEach(() => {
  useConsoleStore.setState({ entries: [], captureEnabled: true, preserveOnSend: true });
});

describe('mirrorGrpcCallToConsole', () => {
  it('records the call with only enabled, named metadata and a grpc native draft', () => {
    mirrorGrpcCallToConsole(request(), response, undefined);
    const [entry] = useConsoleStore.getState().entries;
    expect(entry).toBeDefined();
    expect(entry?.protocol).toBe('grpc');
    expect(entry?.request).toMatchObject({
      method: 'greet.v1.Greeter/SayHello',
      url: 'grpc://localhost:50051',
      headers: { 'x-trace': 'abc' },
      body: '{"name":"ada"}',
    });
    expect(entry?.scriptLogs).toBeUndefined();
    expect(entry?.tests).toBeUndefined();
    expect(entry?.nativeDraft).toMatchObject({
      kind: 'grpc',
      credentialsOmitted: true,
      service: 'greet.v1.Greeter',
      method: 'SayHello',
      metadata: { 'x-trace': 'abc' },
    });
  });

  it('omits the body for an empty message', () => {
    mirrorGrpcCallToConsole(request({ message: '' }), response, undefined);
    expect(useConsoleStore.getState().entries[0]?.request.body).toBeUndefined();
  });

  it('merges pre-request and test logs and maps test results (error only when present)', () => {
    mirrorGrpcCallToConsole(request(), response, {
      preRequest: { success: true, logs: [log('pre')], errors: [], variables: {} },
      test: {
        success: false,
        logs: [log('post')],
        errors: [],
        variables: {},
        tests: [
          { name: 'ok', passed: true },
          { name: 'bad', passed: false, error: 'expected 1' },
        ],
      },
    });
    const [entry] = useConsoleStore.getState().entries;
    expect(entry?.scriptLogs?.map((l) => l.message)).toEqual(['pre', 'post']);
    expect(entry?.tests).toEqual([
      { name: 'ok', passed: true },
      { name: 'bad', passed: false, error: 'expected 1' },
    ]);
  });

  it('handles a script result with only a pre-request phase', () => {
    mirrorGrpcCallToConsole(request(), response, {
      preRequest: { success: true, logs: [], errors: [], variables: {} },
    });
    const [entry] = useConsoleStore.getState().entries;
    expect(entry?.scriptLogs).toBeUndefined();
    expect(entry?.tests).toBeUndefined();
  });
});
