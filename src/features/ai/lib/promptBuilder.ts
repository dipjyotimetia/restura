import {
  type RedactionMode,
  redactBody,
  redactEnvironment,
  redactHeaders,
} from '@shared/protocol/ai/redaction';
import type { ChatMessageWire } from '@shared/protocol/ai/types';
import type { RawSnapshot } from './contextSnapshot';

export const SYSTEM_EXPLAIN_PROMPT =
  `You are an API debugging assistant inside Restura, a multi-protocol API client.

The user is looking at a request and (usually) its response in the app. Your job:
- Explain what the request did and what the response means, plainly.
- If the response is a non-2xx, propose the most likely root causes ordered by probability.
- Suggest concrete next steps the user can take *in Restura* (e.g. "add an Authorization header in the Auth tab", "check that {{baseUrl}} is set in your active environment").
- Never invent endpoints, headers, or fields you didn't see in the supplied context.
- Be concise. Aim for under 200 words unless the user asks for more detail.

When the user refers to "this request" or "this response", they mean the one in <CONTEXT> below.`.trim();

export const SYSTEM_AGENT_PROMPT =
  `You are an autonomous API agent inside Restura, a multi-protocol API client.

You are given a GOAL and the current request/response context. Work toward the goal
step by step using the available tools:
- Propose exactly ONE tool call per turn — the smallest concrete next step.
- After each step the user reviews and applies it; the updated context is then sent
  back to you so you can decide the next step.
- When the goal is fully achieved, reply with a short final summary and DO NOT call
  any tool. The absence of a tool call is how you signal completion.
- Never invent endpoints, headers, or fields you didn't see in the supplied context.
- If the goal cannot be progressed, say so plainly with no tool call.

The user must approve every action, so be deliberate: each proposed step should be a
clear, correct improvement toward the goal.`.trim();

interface BuildArgs {
  snapshot: RawSnapshot;
  priorTurns: ChatMessageWire[];
  userText: string;
  rawMode: boolean;
  /** System prompt override (e.g. the agent prompt). Defaults to the explainer. */
  system?: string;
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
    // Floor of 8 chars (matching the token-pattern minimum in redaction.ts):
    // short structural values — ports ("8080"), versions ("v2", "2024"), path
    // fragments ("api"), region codes — are not secrets, and blanket-replacing
    // them globally mangles the very context the model needs to reason about
    // (e.g. "https://x/api/2024/users" → "https://x/[REDACTED]/[REDACTED]/users").
    // Real secrets are high-entropy and well over 8 chars; the ENVIRONMENT block
    // itself never exposes values regardless (redactEnvironment masks them all).
    if (v.length >= 8) {
      // Escape regex metacharacters in the literal value before substituting.
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
    { role: 'system', content: args.system ?? SYSTEM_EXPLAIN_PROMPT },
    ...args.priorTurns,
    { role: 'user', content: `${args.userText}\n\n${ctx}` },
  ];
}
