export type { GenerateOptions } from './types';

import { generateCurl } from './curl';
import { generatePython } from './python';
import { generateJavaScript } from './javascript';
import { generateNodeJS } from './nodejs';
import { generateGo } from './go';
import { generateRuby } from './ruby';
import { generatePhp } from './php';

export { generateCurl, generatePython, generateJavaScript, generateNodeJS, generateGo, generateRuby, generatePhp };
export { websocketCodeGenerators } from './websocket';
export type { WebSocketGenerateOptions } from './websocket';
export { graphqlCodeGenerators } from './graphql';
export type { GraphQLGenerateOptions } from './graphql';
export { sseCodeGenerators } from './sse';
export type { SseGenerateOptions, SseCodeGeneratorType } from './sse';
export { mcpCodeGenerators } from './mcp';
export type { McpGenerateOptions, McpCodeGeneratorType } from './mcp';

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
