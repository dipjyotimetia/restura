import { describe, expect, it } from 'vitest';
import { validateOcDocument } from '../../src/offering1_lang/validate';
import { classifyOcFile } from '../../src/workspace/collectionDetector';

const ROOT_YAML = `opencollection: "1.0.0"
info:
  name: Sample
`;

const VALID_HTTP = `info:
  type: http
  name: List posts
  seq: 1
http:
  method: GET
  url: "{{API_BASE}}/posts"
  headers:
    - name: Accept
      value: application/json
`;

// Missing required http.url + http.method.
const INVALID_HTTP = `info:
  type: http
  name: Broken
http:
  headers:
    - name: Accept
      value: application/json
`;

const FOLDER_META = `info:
  name: users
`;

describe('classifyOcFile', () => {
  it('detects the root collection file by filename', () => {
    expect(classifyOcFile('/c/opencollection.yml', ROOT_YAML).kind).toBe('root');
  });

  it('detects the root file by the top-level opencollection key regardless of name', () => {
    expect(classifyOcFile('/c/weird-name.yaml', ROOT_YAML).kind).toBe('root');
  });

  it('detects a request file via info.type + protocol key', () => {
    const r = classifyOcFile('/c/list-posts.yaml', VALID_HTTP);
    expect(r.kind).toBe('request');
    if (r.kind === 'request') {
      expect(r.type).toBe('http');
      expect(r.name).toBe('List posts');
    }
  });

  it('classifies _folder.yaml as folder-meta', () => {
    expect(classifyOcFile('/c/users/_folder.yaml', FOLDER_META).kind).toBe('folder-meta');
  });

  it('treats unrelated YAML (info.type but no protocol key) as unknown', () => {
    const unrelated = `info:\n  type: http\n  name: nope\nsomethingElse: true\n`;
    expect(classifyOcFile('/c/random.yaml', unrelated).kind).toBe('unknown');
  });

  it('returns unknown on malformed YAML without throwing', () => {
    expect(classifyOcFile('/c/bad.yaml', 'info: [unclosed').kind).toBe('unknown');
  });
});

describe('validateOcDocument', () => {
  it('returns no diagnostics for a valid request file', () => {
    expect(validateOcDocument('/c/list-posts.yaml', VALID_HTTP)).toEqual([]);
  });

  it('flags schema violations in a request file and locates a line', () => {
    const issues = validateOcDocument('/c/broken.yaml', INVALID_HTTP);
    expect(issues.length).toBeGreaterThan(0);
    // The missing-field issues should point at the `http:` block, not line 0.
    const httpLine = INVALID_HTTP.split('\n').findIndex((l) => l.startsWith('http:'));
    expect(issues.some((i) => i.line === httpLine)).toBe(true);
  });

  it('does not validate root files (owned by yamlValidation)', () => {
    expect(validateOcDocument('/c/opencollection.yml', ROOT_YAML)).toEqual([]);
  });

  it('ignores non-collection YAML', () => {
    expect(validateOcDocument('/c/random.yaml', 'foo: bar\n')).toEqual([]);
  });
});
