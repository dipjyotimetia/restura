import { describe, expect, it } from 'vitest';
import { buildReporters, type RunOpts } from '../run';

const base: RunOpts = {
  bail: false,
  timeout: '30000',
  allowLocalhost: false,
  retry: '0',
  retryOn: '',
};

describe('buildReporters', () => {
  it('refuses two file reporters that resolve to the same --output path', () => {
    expect(() => buildReporters({ ...base, reporter: 'json,junit', output: 'out.xml' })).toThrow(
      /json and junit would both write to out\.xml/
    );
  });

  it('refuses --reporter-output paths that collide', () => {
    expect(() =>
      buildReporters({
        ...base,
        reporter: 'json,html',
        reporterOutput: ['json=./r/a.out', 'html=r/a.out'],
      })
    ).toThrow(/would both write/);
  });

  it('allows distinct per-reporter paths and a non-file reporter beside --output', () => {
    expect(() =>
      buildReporters({
        ...base,
        reporter: 'json,junit',
        reporterOutput: ['json=a.json', 'junit=a.xml'],
      })
    ).not.toThrow();
    expect(() =>
      buildReporters({ ...base, reporter: 'live,junit', output: 'a.xml' })
    ).not.toThrow();
  });
});
