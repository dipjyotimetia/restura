// echo/handlers/ai.ts
import type { Context } from 'hono';

const OPENAI_OK_CHUNKS = [
  `data: {"id":"e1","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n`,
  `data: {"id":"e1","choices":[{"index":0,"delta":{"content":"echo: "},"finish_reason":null}]}\n\n`,
  `data: {"id":"e1","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}\n\n`,
  `data: {"id":"e1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n`,
  `data: [DONE]\n\n`,
];

const ANTHROPIC_OK_EVENTS = [
  `event: message_start\ndata: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","content":[],"model":"claude-test","usage":{"input_tokens":5,"output_tokens":0}}}\n\n`,
  `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`,
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"echo: "}}\n\n`,
  `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n`,
  `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`,
  `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n`,
  `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
];

function streamChunks(chunks: string[], delayMs = 5): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    async pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      const chunk = chunks[i++];
      if (chunk === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunk));
      await new Promise((r) => setTimeout(r, delayMs));
    },
  });
}

function sseResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
  });
}

export async function handleOpenAiChat(c: Context): Promise<Response> {
  const fail = c.req.query('fail');
  if (fail === '429') {
    return new Response('{"error":{"message":"Rate limited","type":"rate_limit_exceeded"}}', { status: 429 });
  }
  if (fail === 'malformed') {
    return sseResponse(streamChunks(['data: {not-json}\n\n']));
  }
  return sseResponse(streamChunks(OPENAI_OK_CHUNKS));
}

export async function handleAnthropicChat(c: Context): Promise<Response> {
  const fail = c.req.query('fail');
  if (fail === '429') {
    return new Response('{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}', { status: 429 });
  }
  if (fail === 'malformed') {
    return sseResponse(streamChunks(['event: content_block_delta\ndata: {not-json}\n\n']));
  }
  return sseResponse(streamChunks(ANTHROPIC_OK_EVENTS));
}
