export type { GenerateOptions } from './types';

import { generateCurl } from './curl';
import { generateGo } from './go';
import { generateJavaScript } from './javascript';
import { generateNodeJS } from './nodejs';
import { generatePhp } from './php';
import { generatePython } from './python';
import { generateRuby } from './ruby';

export type { GraphQLGenerateOptions } from './graphql';
export { graphqlCodeGenerators } from './graphql';
export type { McpCodeGeneratorType, McpGenerateOptions } from './mcp';
export { mcpCodeGenerators } from './mcp';
export type { SseCodeGeneratorType, SseGenerateOptions } from './sse';
export { sseCodeGenerators } from './sse';
export type { WebSocketGenerateOptions } from './websocket';
export { websocketCodeGenerators } from './websocket';
export {
  generateCurl,
  generateGo,
  generateJavaScript,
  generateNodeJS,
  generatePhp,
  generatePython,
  generateRuby,
};

export const codeGenerators = {
  curl: { name: 'cURL', generate: generateCurl },
  python: { name: 'Python (requests)', generate: generatePython },
  javascript: { name: 'JavaScript (fetch)', generate: generateJavaScript },
  nodejs: { name: 'Node.js (axios)', generate: generateNodeJS },
  go: { name: 'Go', generate: generateGo },
  ruby: { name: 'Ruby', generate: generateRuby },
  php: { name: 'PHP', generate: generatePhp },
};

export type CodeGeneratorType = keyof typeof codeGenerators;
