import { escapeJson } from './types';

export interface WebSocketGenerateOptions {
  url: string;
  protocols?: string[];
  headers?: Record<string, string>;
  sampleMessage?: string;
}

export const generateWebSocketJavaScript = (options: WebSocketGenerateOptions): string => {
  const { url, protocols, sampleMessage } = options;
  const wsUrl = url.replace(/^http:\/\//, 'ws://').replace(/^https:\/\//, 'wss://');

  let code = `const ws = new WebSocket("${escapeJson(wsUrl)}"`;
  if (protocols && protocols.length > 0) {
    code += `, ${JSON.stringify(protocols)}`;
  }
  code += `);\n\n`;

  code += `ws.addEventListener('open', () => {\n`;
  code += `  console.log('Connected');\n`;
  if (sampleMessage) {
    code += `  ws.send(${JSON.stringify(sampleMessage)});\n`;
  }
  code += `});\n\n`;

  code += `ws.addEventListener('message', (event) => {\n`;
  code += `  console.log('Received:', event.data);\n`;
  code += `});\n\n`;

  code += `ws.addEventListener('error', (error) => {\n`;
  code += `  console.error('Error:', error);\n`;
  code += `});\n\n`;

  code += `ws.addEventListener('close', (event) => {\n`;
  code += `  console.log(\`Closed: \${event.code} \${event.reason}\`);\n`;
  code += `});\n`;

  return code;
};

export const generateWebSocketPython = (options: WebSocketGenerateOptions): string => {
  const { url, protocols, sampleMessage } = options;
  const wsUrl = url.replace(/^http:\/\//, 'ws://').replace(/^https:\/\//, 'wss://');

  let code = `import asyncio\nimport websockets\n\n`;
  code += `async def main():\n`;
  code += `    uri = "${escapeJson(wsUrl)}"\n`;

  const extras: string[] = [];
  if (protocols && protocols.length > 0) {
    extras.push(`subprotocols=${JSON.stringify(protocols)}`);
  }
  const extraStr = extras.length > 0 ? `, ${extras.join(', ')}` : '';

  code += `    async with websockets.connect(uri${extraStr}) as ws:\n`;
  code += `        print("Connected")\n`;
  if (sampleMessage) {
    code += `        await ws.send(${JSON.stringify(sampleMessage)})\n`;
  }
  code += `        async for message in ws:\n`;
  code += `            print(f"Received: {message}")\n\n`;
  code += `asyncio.run(main())\n`;

  return code;
};

export const generateWebSocketNodeJS = (options: WebSocketGenerateOptions): string => {
  const { url, protocols, sampleMessage, headers } = options;
  const wsUrl = url.replace(/^http:\/\//, 'ws://').replace(/^https:\/\//, 'wss://');

  let code = `const WebSocket = require('ws');\n\n`;

  const optParts: string[] = [];
  if (protocols && protocols.length > 0) {
    optParts.push(`  protocol: ${JSON.stringify(protocols.join(','))}`);
  }
  if (headers && Object.keys(headers).length > 0) {
    const hLines = Object.entries(headers).map(([k, v]) => `    "${escapeJson(k)}": "${escapeJson(v)}"`).join(',\n');
    optParts.push(`  headers: {\n${hLines}\n  }`);
  }

  if (optParts.length > 0) {
    code += `const ws = new WebSocket("${escapeJson(wsUrl)}", {\n${optParts.join(',\n')}\n});\n\n`;
  } else {
    code += `const ws = new WebSocket("${escapeJson(wsUrl)}");\n\n`;
  }

  code += `ws.on('open', () => {\n`;
  code += `  console.log('Connected');\n`;
  if (sampleMessage) {
    code += `  ws.send(${JSON.stringify(sampleMessage)});\n`;
  }
  code += `});\n\n`;

  code += `ws.on('message', (data) => {\n`;
  code += `  console.log('Received:', data.toString());\n`;
  code += `});\n\n`;

  code += `ws.on('error', (err) => console.error('Error:', err));\n`;
  code += `ws.on('close', (code, reason) => console.log(\`Closed: \${code} \${reason}\`));\n`;

  return code;
};

export const websocketCodeGenerators = {
  javascript: { name: 'JavaScript (WebSocket)', generate: generateWebSocketJavaScript },
  python: { name: 'Python (websockets)', generate: generateWebSocketPython },
  nodejs: { name: 'Node.js (ws)', generate: generateWebSocketNodeJS },
};
