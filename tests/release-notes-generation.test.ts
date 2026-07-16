import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('release-note generation', () => {
  const cliffConfig = readFileSync(resolve(process.cwd(), 'cliff.toml'), 'utf8');

  it('emits only generated changelog content', () => {
    expect(cliffConfig).not.toContain('## Highlights');
    expect(cliffConfig).not.toContain('## Upgrade notes');
    expect(cliffConfig).not.toContain('Before publishing');
    expect(cliffConfig).toContain(
      '## {{ version | trim_start_matches(pat="v") }} — {{ timestamp | date(format="%Y-%m-%d") }}'
    );
    expect(cliffConfig).toContain('## {{ group | upper_first }}');
    expect(cliffConfig).toContain(
      'https://github.com/dipjyotimetia/restura/commit/{{ commit.id }}'
    );
  });
});
