export type { GenerateOptions } from './types';
export { generateCurl } from './curl';
export { generatePython } from './python';
export { generateJavaScript } from './javascript';
export { generateNodeJS } from './nodejs';
export { generateGo } from './go';
export { generateRuby } from './ruby';
export { generatePhp } from './php';

import { generateCurl } from './curl';
import { generatePython } from './python';
import { generateJavaScript } from './javascript';
import { generateNodeJS } from './nodejs';
import { generateGo } from './go';
import { generateRuby } from './ruby';
import { generatePhp } from './php';

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
