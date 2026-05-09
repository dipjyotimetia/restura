import { v4 as uuidv4 } from 'uuid';

const FIRST_NAMES = ['alice', 'bob', 'carol', 'dave', 'eve', 'frank', 'grace', 'henry'];
const DOMAINS = ['example.com', 'test.io', 'sample.net', 'demo.dev'];

type Generator = () => string;

const HELPERS: Record<string, Generator> = {
  timestamp: () => String(Date.now()),
  isoTimestamp: () => new Date().toISOString(),
  randomInt: () => String(Math.floor(Math.random() * 1000)),
  guid: () => uuidv4(),
  randomUUID: () => uuidv4(),
  randomAlphaNumeric: () => Math.random().toString(36).slice(2, 10),
  randomEmail: () => {
    const name = FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)] ?? 'user';
    const domain = DOMAINS[Math.floor(Math.random() * DOMAINS.length)] ?? 'example.com';
    const suffix = Math.floor(Math.random() * 1000);
    return `${name}.${suffix}@${domain}`;
  },
};

const PATTERN = /\{\{\s*\$([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;

export function applyDynamicVariables(text: string): string {
  return text.replace(PATTERN, (match, name: string) => {
    const generator = HELPERS[name];
    return generator ? generator() : match;
  });
}
