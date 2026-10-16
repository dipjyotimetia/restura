/**
 * Per-frame assertion scripts for received WebSocket frames (#931).
 *
 * When a connection has `frameAssertion.enabled` and a non-empty script, every
 * newly *received* frame is evaluated in the QuickJS sandbox
 * (`shared/scripts/script-executor.ts` — no DOM, network or filesystem) with
 * the frame bound as the test-script `response`: `pm.response.text()` is the
 * raw frame, `pm.response.json()` parses it, `pm.test`/`pm.expect` record
 * results. The outcome is written onto the message so the transcript can show
 * pass/fail. Frames that arrived before the script was enabled are not
 * re-evaluated.
 *
 * One long-lived executor per connection (the sandbox bundle is initialised
 * once) and evaluations are serialised per connection. A bounded queue keeps a
 * flood of frames from piling up unbounded sandbox work.
 *
 * No variable scope is passed to the sandbox (`pm.environment.get` returns
 * undefined): the watcher runs for background tabs too, and the only scope
 * resolver available is the *active* tab's, which could expose another
 * collection's (secret) variables. Frames larger than
 * `MAX_FRAME_ASSERTION_BYTES` are skipped, and the sandbox is recreated after
 * a runtime failure (e.g. out of memory).
 */

import type { ScriptResult } from '@shared/scripts/script-executor';
import ScriptExecutor from '@shared/scripts/script-executor';
import {
  type FrameAssertionResult,
  useWebSocketStore,
  type WebSocketConnection,
  type WebSocketMessage,
} from '@/features/websocket/store/useWebSocketStore';

/** Frames waiting for evaluation per connection before new ones are skipped. */
export const MAX_PENDING_FRAME_ASSERTIONS = 50;
/** Frames above this size are not evaluated (bounded sandbox work per frame). */
export const MAX_FRAME_ASSERTION_BYTES = 256 * 1024;
const RUNTIME_FAILURE = /out of memory|stack overflow|interrupted|InternalError/i;

function usableScript(config: WebSocketConnection['frameAssertion']): string | null {
  if (!config || config.enabled !== true || typeof config.script !== 'string') return null;
  return config.script.trim() ? config.script : null;
}

export function toFrameAssertionResult(result: ScriptResult): FrameAssertionResult {
  const tests = result.tests ?? [];
  const errors = result.errors ?? [];
  // A failing pm.test also lands in `errors` (and clears `success`), so a
  // failed assertion wins over the generic error classification.
  const status = tests.some((t) => !t.passed)
    ? 'failed'
    : !result.success || errors.length > 0
      ? 'error'
      : 'passed';
  return { status, tests, errors };
}

interface ExecutorLike {
  initialize(): Promise<void>;
  eval(script: string, context: Parameters<ScriptExecutor['eval']>[1]): Promise<ScriptResult>;
  dispose(): void;
}

export type ExecutorFactory = (envVars: Record<string, string>) => ExecutorLike;

const defaultFactory: ExecutorFactory = (envVars) => new ScriptExecutor({ envVars });

interface Session {
  script: string;
  executor: ExecutorLike;
  ready: Promise<void>;
  tail: Promise<void>;
  pending: number;
  seen: Set<string>;
  disposed: boolean;
}

function frameSize(message: WebSocketMessage): number {
  return message.binaryData?.byteLength ?? new Blob([message.content]).size;
}

export class FrameAssertionRunner {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly factory: ExecutorFactory = defaultFactory) {}

  /** Reconcile sessions with the store and enqueue any newly received frames. */
  sync(connections: Record<string, WebSocketConnection>): void {
    for (const [id, session] of this.sessions) {
      const script = usableScript(connections[id]?.frameAssertion);
      if (script === null || script !== session.script) this.dispose(id);
    }

    for (const [id, conn] of Object.entries(connections)) {
      const script = usableScript(conn.frameAssertion);
      if (script === null) continue;
      let session = this.sessions.get(id);
      if (!session) {
        session = this.createSession(script, conn.messages);
        this.sessions.set(id, session);
        continue; // frames already present when the script was enabled are skipped
      }
      this.enqueueNew(id, session, conn.messages);
    }
  }

  dispose(connectionId: string): void {
    const session = this.sessions.get(connectionId);
    if (!session) return;
    session.disposed = true;
    this.sessions.delete(connectionId);
    // Let in-flight work settle before freeing the QuickJS runtime.
    void session.tail.finally(() => session.executor.dispose());
  }

  disposeAll(): void {
    for (const id of [...this.sessions.keys()]) this.dispose(id);
  }

  /** Resolves once every queued evaluation for `connectionId` has finished. */
  idle(connectionId: string): Promise<void> {
    return this.sessions.get(connectionId)?.tail ?? Promise.resolve();
  }

  private createSession(script: string, messages: WebSocketMessage[]): Session {
    const executor = this.factory({});
    const ready = executor.initialize();
    return {
      script,
      executor,
      ready,
      tail: ready.catch(() => undefined),
      pending: 0,
      seen: new Set(messages.map((m) => m.id)),
      disposed: false,
    };
  }

  /** Runs inside the serialized tail, so no evaluation is using the old executor. */
  private recreateExecutor(session: Session): void {
    try {
      session.executor.dispose();
    } catch {
      // A crashed runtime may fail to dispose; it is dropped either way.
    }
    session.executor = this.factory({});
    session.ready = session.executor.initialize();
    session.ready.catch(() => undefined);
  }

  private enqueueNew(connectionId: string, session: Session, messages: WebSocketMessage[]): void {
    const fresh: WebSocketMessage[] = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i] as WebSocketMessage;
      if (session.seen.has(message.id)) break;
      session.seen.add(message.id);
      if (message.type === 'received') fresh.unshift(message);
    }
    if (session.seen.size > messages.length * 2 + 100) {
      session.seen = new Set(messages.map((m) => m.id));
    }
    for (const message of fresh) this.enqueue(connectionId, session, message);
  }

  private enqueue(connectionId: string, session: Session, message: WebSocketMessage): void {
    const store = useWebSocketStore.getState();
    if (frameSize(message) > MAX_FRAME_ASSERTION_BYTES) {
      store.setMessageAssertion(connectionId, message.id, {
        status: 'error',
        tests: [],
        errors: ['Skipped: frame larger than 256 KB'],
      });
      return;
    }
    if (session.pending >= MAX_PENDING_FRAME_ASSERTIONS) {
      store.setMessageAssertion(connectionId, message.id, {
        status: 'error',
        tests: [],
        errors: ['Skipped: frame assertion queue is full'],
      });
      return;
    }
    session.pending++;
    session.tail = session.tail.then(async () => {
      try {
        if (session.disposed) return;
        await session.ready;
        const result = await session.executor.eval(session.script, {
          response: {
            status: 0,
            statusText: 'frame',
            headers: {},
            body: message.content,
            time: 0,
            size: frameSize(message),
          },
          info: { requestName: 'WebSocket frame', eventName: 'test' },
        });
        if (session.disposed) return;
        if (!result.success && (result.errors ?? []).some((e) => RUNTIME_FAILURE.test(e))) {
          this.recreateExecutor(session);
        }
        useWebSocketStore
          .getState()
          .setMessageAssertion(connectionId, message.id, toFrameAssertionResult(result));
      } catch (error) {
        if (session.disposed) return;
        // A throw out of eval means the runtime itself is suspect — start fresh.
        this.recreateExecutor(session);
        useWebSocketStore.getState().setMessageAssertion(connectionId, message.id, {
          status: 'error',
          tests: [],
          errors: [error instanceof Error ? error.message : String(error)],
        });
      } finally {
        session.pending--;
      }
    });
  }
}

let watcher: { runner: FrameAssertionRunner; unsubscribe: () => void } | null = null;

/**
 * Start the app-wide watcher (idempotent). Runs for every WebSocket
 * connection, including ones in background tabs.
 */
export function startFrameAssertionWatcher(): FrameAssertionRunner {
  if (watcher) return watcher.runner;
  const runner = new FrameAssertionRunner();
  let last = useWebSocketStore.getState().connections;
  runner.sync(last);
  const unsubscribe = useWebSocketStore.subscribe((state) => {
    if (state.connections === last) return;
    last = state.connections;
    runner.sync(last);
  });
  watcher = { runner, unsubscribe };
  return runner;
}

/** Test helper: tear the watcher down so the next start is fresh. */
export function stopFrameAssertionWatcher(): void {
  if (!watcher) return;
  watcher.unsubscribe();
  watcher.runner.disposeAll();
  watcher = null;
}
