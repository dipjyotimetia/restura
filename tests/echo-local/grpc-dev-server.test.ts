// @vitest-environment node
import { type ChildProcess, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fromBinary } from '@bufbuild/protobuf';
import { Code, ConnectError, createClient } from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EchoReplySchema, EchoService } from '../../e2e/mocks/proto/gen/echo_pb';

// The native gRPC dev server (scripts/grpc-dev-server.mjs) is the upstream the
// DESKTOP e2e suite and echo-local dial. It must offer the same testing aids as
// the Connect mock the web suite uses (e2e/mocks/grpcServer.ts), or desktop
// can never exercise rich error details, trailers or slow/cancelled streams.
// Driven over the real wire with the same transport the desktop client uses.

let child: ChildProcess;
let baseUrl = '';

beforeAll(async () => {
  child = spawn(process.execPath, [resolve(process.cwd(), 'scripts/grpc-dev-server.mjs')], {
    env: { ...process.env, GRPC_PORT: '0', GRPC_HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  baseUrl = await new Promise<string>((done, reject) => {
    const timer = setTimeout(() => reject(new Error('gRPC dev server did not start')), 15_000);
    let out = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      const m = /Listening\s+grpc:\/\/localhost:(\d+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        done(`http://127.0.0.1:${m[1]}`);
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`gRPC dev server exited early (code ${code})`));
    });
  });
}, 20_000);

afterAll(async () => {
  await new Promise<void>((done) => {
    child.once('exit', () => done());
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 3_000).unref();
  });
});

function client() {
  return createClient(EchoService, createGrpcTransport({ baseUrl }));
}

describe('grpc-dev-server parity with the Connect mock', () => {
  it('GRPC_PORT=0 binds an ephemeral port (not the 50051 default)', () => {
    expect(baseUrl).not.toContain(':50051');
  });

  it('FAIL_WITH_DETAILS → FAILED_PRECONDITION with an echo.v1.EchoReply detail', async () => {
    const err = await client()
      .unaryEcho({ message: 'FAIL_WITH_DETAILS' })
      .then(() => null)
      .catch((e: unknown) => ConnectError.from(e));
    expect(err).not.toBeNull();
    expect(err!.code).toBe(Code.FailedPrecondition);
    expect(err!.rawMessage).toBe('mock-server triggered FAIL_WITH_DETAILS');
    const detail = err!.details[0] as { type: string; value: Uint8Array };
    expect(detail.type).toBe('echo.v1.EchoReply');
    const reply = fromBinary(EchoReplySchema, detail.value);
    expect(reply.message).toBe('detail');
    expect(reply.index).toBe(7);
  });

  it('plain FAIL_* triggers map to their status code', async () => {
    const err = await client()
      .unaryEcho({ message: 'FAIL_NOT_FOUND' })
      .then(() => null)
      .catch((e: unknown) => ConnectError.from(e));
    expect(err?.code).toBe(Code.NotFound);
  });

  it('mirrors x-echo-* headers and ends unary calls with an x-echo-count trailer', async () => {
    let header = '';
    let trailer = '';
    const reply = await client().unaryEcho(
      { message: 'hi' },
      {
        headers: { 'x-echo-trace': 'abc-123' },
        onHeader: (h) => {
          header = h.get('x-echo-trace') ?? '';
        },
        onTrailer: (t) => {
          trailer = t.get('x-echo-count') ?? '';
        },
      }
    );
    expect(reply.message).toBe('echo: hi');
    expect(header).toBe('abc-123');
    expect(trailer).toBe('1');
  });

  it('SLOW_<ms>: delays each server-streaming reply and still trails x-echo-count', async () => {
    let trailer = '';
    const started = Date.now();
    const messages: string[] = [];
    for await (const r of client().serverStreamingEcho(
      { message: 'SLOW_120:tick', count: 2 },
      {
        onTrailer: (t) => {
          trailer = t.get('x-echo-count') ?? '';
        },
      }
    )) {
      messages.push(r.message);
    }
    expect(messages).toEqual(['echo: tick', 'echo: tick']);
    expect(Date.now() - started).toBeGreaterThanOrEqual(220);
    expect(trailer).toBe('2');
  });

  it('a client deadline cancels a slow stream with DEADLINE_EXCEEDED', async () => {
    const err = await (async () => {
      try {
        for await (const _ of client().serverStreamingEcho(
          { message: 'SLOW_500:slow', count: 5 },
          { timeoutMs: 300 }
        )) {
          // drain
        }
        return null;
      } catch (e) {
        return ConnectError.from(e);
      }
    })();
    expect(err?.code).toBe(Code.DeadlineExceeded);
  });
});
