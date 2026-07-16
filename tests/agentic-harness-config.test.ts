import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const packageJson = JSON.parse(
  readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')
) as { scripts: Record<string, string> };

describe('agentic harness package scripts', () => {
  it.each(['test:coverage', 'test:ci'])('%s generates sandbox libraries first', (name) => {
    expect(packageJson.scripts[name]).toMatch(
      /^node scripts\/ensure-sandbox-libs\.mjs && vitest run --coverage/
    );
  });

  it('makes validate coverage-aware', () => {
    expect(packageJson.scripts.validate).toContain('npm run test:ci');
    expect(packageJson.scripts.validate).not.toContain('npm run test:run');
  });
});
