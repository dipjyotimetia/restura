// @vitest-environment node
import { describe, expect, it } from 'vitest';
import app from '../index';

async function readAll(res: Response): Promise<string> {
  return await res.text();
}

function sseDataLines(text: string): string[] {
  return text
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => l.slice('data: '.length));
}

describe('AI echo handlers', () => {
  it('POST /v1/chat/completions streams an OpenAI-shaped "echo: hello" and [DONE]', async () => {
    const res = await app.request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'hello' }] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const lines = sseDataLines(await readAll(res));
    expect(lines.at(-1)).toBe('[DONE]');
    const text = lines
      .filter((l) => l !== '[DONE]')
      .map((l) => JSON.parse(l) as { choices: Array<{ delta: { content?: string } }> })
      .map((c) => c.choices[0]?.delta.content ?? '')
      .join('');
    expect(text).toBe('echo: hello');
  });

  it('POST /v1/messages streams Anthropic-shaped events ending in message_stop', async () => {
    const res = await app.request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'hello' }] }),
    });
    expect(res.status).toBe(200);
    const body = await readAll(res);
    expect(body).toContain('event: message_start');
    expect(body).toContain('"text":"echo: "');
    expect(body.trimEnd().endsWith('data: {"type":"message_stop"}')).toBe(true);
  });

  it('?fail=429 returns a rate-limit error on both shapes', async () => {
    for (const path of ['/v1/chat/completions', '/v1/messages']) {
      const res = await app.request(`http://localhost${path}?fail=429`, { method: 'POST' });
      expect(res.status, path).toBe(429);
    }
  });

  it('?fail=malformed streams a non-JSON chunk', async () => {
    const res = await app.request('http://localhost/v1/chat/completions?fail=malformed', {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(await readAll(res)).toContain('data: {not-json}');
  });
});
