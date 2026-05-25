import type { ChatMessageWire } from '@shared/protocol/ai/types';
import { redactHeaders, redactBody, redactEnvironment, type RedactionMode } from '@shared/protocol/ai/redaction';
import type { RawSnapshot } from './contextSnapshot';

export const SYSTEM_EXPLAIN_PROMPT = `You are an API debugging assistant inside Restura, a multi-protocol API client.

The user is looking at a request and (usually) its response in the app. Your job:
- Explain what the request did and what the response means, plainly.
- If the response is a non-2xx, propose the most likely root causes ordered by probability.
- Suggest concrete next steps the user can take *in Restura* (e.g. "add an Authorization header in the Auth tab", "check that {{baseUrl}} is set in your active environment").
- Never invent endpoints, headers, or fields you didn't see in the supplied context.
- Be concise. Aim for under 200 words unless the user asks for more detail.

When the user refers to "this request" or "this response", they mean the one in <CONTEXT> below.`.trim();

interface BuildArgs {
  snapshot: RawSnapshot;
  priorTurns: ChatMessageWire[];
  userText: string;
  rawMode: boolean;
}

/**
 * In default mode, replace occurrences of any environment variable *value*
 * inside `text` with `[REDACTED]`. This prevents env secrets that are
 * interpolated into URLs, bodies, or headers from leaking to the model.
 */
function redactEnvValues(text: string, env: Record<string, string> | undefined): string {
  if (!env) return text;
  let out = text;
  for (const v of Object.values(env)) {
    if (v.length >= 4) {
      // Escape special regex characters in the literal value before substituting.
      const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp(escaped, 'g'), '[REDACTED]');
    }
  }
  return out;
}

function renderContext(snapshot: RawSnapshot, mode: RedactionMode): string {
  if (snapshot.contextRef.kind === 'none' || !snapshot.request) {
    return '<CONTEXT>\n(no active request)\n</CONTEXT>';
  }
  const lines: string[] = ['<CONTEXT>'];

  const url =
    mode === 'default'
      ? redactEnvValues(snapshot.request.url, snapshot.environment)
      : snapshot.request.url;

  lines.push(`REQUEST: ${snapshot.request.method} ${url}`);
  const reqHeaders = redactHeaders(snapshot.request.headers, mode);
  for (const [k, v] of Object.entries(reqHeaders)) {
    const vv = mode === 'default' ? redactEnvValues(v, snapshot.environment) : v;
    lines.push(`  ${k}: ${vv}`);
  }
  if (snapshot.request.body) {
    lines.push('REQUEST BODY:');
    const rawBody = redactBody(snapshot.request.body, mode);
    lines.push(mode === 'default' ? redactEnvValues(rawBody, snapshot.environment) : rawBody);
  }
  if (snapshot.response) {
    lines.push(`RESPONSE: ${snapshot.response.status}`);
    const resHeaders = redactHeaders(snapshot.response.headers, mode);
    for (const [k, v] of Object.entries(resHeaders)) {
      const vv = mode === 'default' ? redactEnvValues(v, snapshot.environment) : v;
      lines.push(`  ${k}: ${vv}`);
    }
    if (snapshot.response.body) {
      lines.push('RESPONSE BODY:');
      const rawBody = redactBody(snapshot.response.body, mode);
      lines.push(mode === 'default' ? redactEnvValues(rawBody, snapshot.environment) : rawBody);
    }
  }
  if (snapshot.environment) {
    const env = redactEnvironment(snapshot.environment, mode);
    lines.push('ENVIRONMENT:');
    for (const [k, v] of Object.entries(env)) lines.push(`  ${k} = ${v}`);
  }
  lines.push('</CONTEXT>');
  return lines.join('\n');
}

export function buildMessages(args: BuildArgs): ChatMessageWire[] {
  const mode: RedactionMode = args.rawMode ? 'raw' : 'default';
  const ctx = renderContext(args.snapshot, mode);
  return [
    { role: 'system', content: SYSTEM_EXPLAIN_PROMPT },
    ...args.priorTurns,
    { role: 'user', content: `${args.userText}\n\n${ctx}` },
  ];
}
