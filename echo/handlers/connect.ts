import { createConnectRouter } from '@connectrpc/connect';
import { create } from '@bufbuild/protobuf';
import {
  EchoService,
  EchoReplySchema,
  EchoSummarySchema,
} from '../../e2e/mocks/proto/gen/echo_pb';

const COUNT_MIN = 1;
const COUNT_MAX = 10;

const router = createConnectRouter().service(EchoService, {
  async unaryEcho(req) {
    return create(EchoReplySchema, { message: `echo: ${req.message}`, index: 0 });
  },
  async *serverStreamingEcho(req) {
    const count = Math.min(Math.max(req.count, COUNT_MIN), COUNT_MAX);
    for (let i = 0; i < count; i++) {
      yield create(EchoReplySchema, { message: `echo: ${req.message}`, index: i });
    }
  },
  async clientStreamingEcho(reqs) {
    let count = 0;
    const parts: string[] = [];
    for await (const req of reqs) {
      count++;
      parts.push(req.message);
    }
    return create(EchoSummarySchema, { messageCount: count, concatenated: parts.join('|') });
  },
  async *bidirectionalEcho(reqs) {
    let idx = 0;
    for await (const req of reqs) {
      yield create(EchoReplySchema, { message: `echo: ${req.message}`, index: idx++ });
    }
  },
});

async function* bodyToIterable(
  body: ReadableStream<Uint8Array> | null
): AsyncIterable<Uint8Array> {
  if (!body) return;
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

export async function connectEcho(req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  const handler = router.handlers.find((h) => h.requestPath === url.pathname);
  if (!handler) return null;

  const universalReq = {
    httpVersion: '1.1',
    url: req.url,
    method: req.method,
    header: req.headers,
    body: bodyToIterable(req.body),
    signal: req.signal ?? new AbortController().signal,
  };

  const universalRes = await handler(universalReq);

  const headers = new Headers(universalRes.header);
  if (!universalRes.body) {
    return new Response(null, { status: universalRes.status, headers });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for await (const chunk of universalRes.body!) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });

  return new Response(stream, { status: universalRes.status, headers });
}
