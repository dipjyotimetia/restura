import type { SseRequest } from '@/types';

export interface SseGenerateOptions {
  request: SseRequest;
}

function enabledHeaders(req: SseRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of req.headers) {
    if (h.enabled && h.key.trim()) out[h.key.trim()] = h.value;
  }
  return out;
}

/** EventSource: simple, no headers — what most browsers can do natively */
function generateEventSource({ request }: SseGenerateOptions): string {
  return `// Browser EventSource — no custom headers supported
const source = new EventSource(${JSON.stringify(request.url)});

source.onmessage = (event) => {
  console.log('event', event.data);
};

source.addEventListener('error', (err) => {
  console.error('SSE error', err);
});`;
}

/** fetch + ReadableStream parsing — supports custom headers */
function generateFetchStream({ request }: SseGenerateOptions): string {
  const headers = enabledHeaders(request);
  return `// fetch + ReadableStream — supports custom headers
const response = await fetch(${JSON.stringify(request.url)}, {
  method: 'GET',
  headers: ${JSON.stringify({ Accept: 'text/event-stream', ...headers }, null, 2).replace(/\n/g, '\n  ')},
});

if (!response.ok || !response.body) throw new Error(\`HTTP \${response.status}\`);

const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = '';

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  // Split on event boundary (blank line)
  const parts = buffer.split(/\\r?\\n\\r?\\n/);
  buffer = parts.pop() ?? '';
  for (const part of parts) {
    const lines = part.split(/\\r?\\n/);
    const dataLines = lines.filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, ''));
    if (dataLines.length) console.log('event', dataLines.join('\\n'));
  }
}`;
}

function generateCurl({ request }: SseGenerateOptions): string {
  const headerArgs = Object.entries(enabledHeaders(request))
    .map(([k, v]) => `  -H ${JSON.stringify(`${k}: ${v}`)}`)
    .join(' \\\n');
  return `curl -N -H 'Accept: text/event-stream' \\
${headerArgs ? `${headerArgs} \\\n` : ''}  ${JSON.stringify(request.url)}`;
}

export const sseCodeGenerators = {
  eventSource: { name: 'JavaScript (EventSource)', generate: generateEventSource },
  fetchStream: { name: 'JavaScript (fetch + stream)', generate: generateFetchStream },
  curl: { name: 'cURL', generate: generateCurl },
};

export type SseCodeGeneratorType = keyof typeof sseCodeGenerators;
