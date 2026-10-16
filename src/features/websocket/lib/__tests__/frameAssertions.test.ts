import type { ScriptResult } from '@shared/scripts/script-executor';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWebSocketStore } from '@/features/websocket/store/useWebSocketStore';
import {
  type ExecutorFactory,
  FrameAssertionRunner,
  MAX_PENDING_FRAME_ASSERTIONS,
  startFrameAssertionWatcher,
  stopFrameAssertionWatcher,
  toFrameAssertionResult,
} from '../frameAssertions';

vi.mock('@/lib/shared/streaming/messageVariables', () => ({
  getActiveStreamingVariableScope: () => ({
    values: { expected: 'pong' },
    secretNames: new Set(),
    handleNames: new Set(),
  }),
}));

const ok = (tests: ScriptResult['tests'] = []): ScriptResult => ({
  success: true,
  logs: [],
  errors: [],
  variables: {},
  tests,
});

function fakeFactory(evalImpl: (script: string, body: unknown) => Promise<ScriptResult>) {
  const instances: Array<{
    dispose: ReturnType<typeof vi.fn>;
    eval: ReturnType<typeof vi.fn>;
    envVars: Record<string, string>;
  }> = [];
  const factory: ExecutorFactory = (envVars) => {
    const instance = {
      envVars,
      initialize: vi.fn(async () => {}),
      eval: vi.fn(async (script: string, ctx?: { response?: { body: unknown } }) =>
        evalImpl(script, ctx?.response?.body)
      ),
      dispose: vi.fn(),
    };
    instances.push(instance);
    return instance;
  };
  return { factory, instances };
}

const store = () => useWebSocketStore.getState();
const messages = (id: string) => store().connections[id]?.messages ?? [];

describe('toFrameAssertionResult', () => {
  it('classifies passed / failed / error', () => {
    expect(toFrameAssertionResult(ok([{ name: 'a', passed: true }])).status).toBe('passed');
    expect(toFrameAssertionResult(ok()).status).toBe('passed');
    expect(toFrameAssertionResult(ok([{ name: 'a', passed: false }])).status).toBe('failed');
    expect(toFrameAssertionResult({ ...ok(), success: false }).status).toBe('error');
    expect(toFrameAssertionResult({ ...ok(), errors: ['boom'] }).status).toBe('error');
    expect(
      toFrameAssertionResult({
        ...ok([{ name: 'a', passed: false }]),
        success: false,
        errors: ['✗ a'],
      }).status
    ).toBe('failed');
    expect(
      toFrameAssertionResult({ success: true, logs: [], errors: undefined, variables: {} } as never)
    ).toEqual({ status: 'passed', tests: [], errors: [] });
  });
});

describe('FrameAssertionRunner', () => {
  let id: string;

  beforeEach(() => {
    id = store().createConnection();
  });

  afterEach(() => {
    store().removeConnection(id);
  });

  it('evaluates only frames received after the script is enabled', async () => {
    const { factory, instances } = fakeFactory(async (_s, body) =>
      ok([{ name: 'is pong', passed: body === 'pong' }])
    );
    const runner = new FrameAssertionRunner(factory);
    store().addMessage(id, 'received', 'before');
    store().setFrameAssertion(id, { enabled: true, script: 'pm.test()' });
    runner.sync(store().connections);
    expect(instances[0]?.envVars).toEqual({ expected: 'pong' });

    store().addMessage(id, 'sent', 'ping');
    store().addMessage(id, 'received', 'pong');
    store().addMessage(id, 'received', 'nope');
    runner.sync(store().connections);
    await runner.idle(id);

    const [before, sent, pong, nope] = messages(id);
    expect(before?.assertion).toBeUndefined();
    expect(sent?.assertion).toBeUndefined();
    expect(pong?.assertion?.status).toBe('passed');
    expect(nope?.assertion?.status).toBe('failed');
    expect(instances[0]?.eval).toHaveBeenCalledTimes(2);
  });

  it('disposes the session when disabled, removed or the script changes', async () => {
    const { factory, instances } = fakeFactory(async () => ok());
    const runner = new FrameAssertionRunner(factory);
    store().setFrameAssertion(id, { enabled: true, script: 'a' });
    runner.sync(store().connections);
    store().setFrameAssertion(id, { enabled: true, script: 'b' });
    runner.sync(store().connections);
    await Promise.resolve();
    await runner.idle(id);
    expect(instances).toHaveLength(2);
    expect(instances[0]?.dispose).toHaveBeenCalled();

    store().setFrameAssertion(id, { enabled: false, script: 'b' });
    runner.sync(store().connections);
    await new Promise((r) => setTimeout(r, 0));
    expect(instances[1]?.dispose).toHaveBeenCalled();

    store().setFrameAssertion(id, { enabled: true, script: '   ' });
    runner.sync(store().connections);
    expect(instances).toHaveLength(2);
    runner.disposeAll();
  });

  it('records sandbox exceptions and initialisation failures as errors', async () => {
    const { factory } = fakeFactory(async () => {
      throw new Error('sandbox exploded');
    });
    const runner = new FrameAssertionRunner(factory);
    store().setFrameAssertion(id, { enabled: true, script: 'x' });
    runner.sync(store().connections);
    store().addMessage(id, 'received', 'frame');
    runner.sync(store().connections);
    await runner.idle(id);
    expect(messages(id)[0]?.assertion).toEqual({
      status: 'error',
      tests: [],
      errors: ['sandbox exploded'],
    });
    runner.disposeAll();
  });

  it('skips frames once the queue is full', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { factory } = fakeFactory(async () => {
      await gate;
      return ok();
    });
    const runner = new FrameAssertionRunner(factory);
    store().setFrameAssertion(id, { enabled: true, script: 'x' });
    runner.sync(store().connections);
    for (let i = 0; i < MAX_PENDING_FRAME_ASSERTIONS + 1; i++) {
      store().addMessage(id, 'received', `f${i}`);
    }
    runner.sync(store().connections);
    expect(messages(id).at(-1)?.assertion?.errors[0]).toMatch(/queue is full/);
    release();
    await runner.idle(id);
    expect(messages(id)[0]?.assertion?.status).toBe('passed');
    runner.disposeAll();
  });

  it('runs a real QuickJS assertion against the frame', async () => {
    const runner = new FrameAssertionRunner();
    store().setFrameAssertion(id, {
      enabled: true,
      script: `pm.test('type is pong', () => { pm.expect(pm.response.json().type).to.equal(pm.environment.get('expected')); });`,
    });
    runner.sync(store().connections);
    store().addMessage(id, 'received', '{"type":"pong"}');
    store().addMessage(id, 'received', '{"type":"other"}');
    runner.sync(store().connections);
    await runner.idle(id);
    const [first, second] = messages(id);
    expect(first?.assertion?.status).toBe('passed');
    expect(first?.assertion?.tests[0]?.name).toBe('type is pong');
    expect(second?.assertion?.status).toBe('failed');
    runner.disposeAll();
  }, 20_000);
});

describe('startFrameAssertionWatcher', () => {
  afterEach(() => stopFrameAssertionWatcher());

  it('is idempotent and reacts to store updates', async () => {
    const runner = startFrameAssertionWatcher();
    expect(startFrameAssertionWatcher()).toBe(runner);
    const sync = vi.spyOn(runner, 'sync');
    const id = store().createConnection();
    expect(sync).toHaveBeenCalled();
    sync.mockClear();
    store().setSearchQuery('x');
    expect(sync).not.toHaveBeenCalled();
    store().setSearchQuery('');
    store().removeConnection(id);
    stopFrameAssertionWatcher();
    stopFrameAssertionWatcher();
  });
});
