import { describe, it, expect } from 'vitest';
import { renderJUnitXml } from '../junit';
import type { RunResult, RequestRunResult } from '../types';
import type { LoadedRequest } from '../../runner/collectionLoader';

const fakeReq = (name: string): LoadedRequest => ({
  filePath: '/x/y.http.yaml',
  relativePath: 'y.http.yaml',
  type: 'http',
  request: {
    id: '1',
    name,
    type: 'http',
    method: 'GET',
    url: '/',
    headers: [],
    params: [],
    body: { type: 'none' },
    auth: { type: 'none' },
  } as never,
});

describe('renderJUnitXml', () => {
  it('renders a passing testcase', () => {
    const result: RunResult = {
      meta: { collectionName: 'My', collectionDir: '/x', startedAt: 1 },
      durationMs: 100,
      requests: [
        {
          request: fakeReq('OK req'),
          status: 200,
          passed: true,
          durationMs: 50,
          bodyBytes: 0,
        } as RequestRunResult,
      ],
      summary: { total: 1, passed: 1, failed: 0, errored: 0 },
    };
    const xml = renderJUnitXml(result);
    expect(xml).toContain('<?xml');
    expect(xml).toContain('<testsuites name="My"');
    expect(xml).toContain('classname="http" name="OK req"');
    expect(xml).not.toContain('<failure');
    expect(xml).not.toContain('<error');
  });

  it('renders a failure testcase for non-2xx', () => {
    const result: RunResult = {
      meta: { collectionName: 'My', collectionDir: '/x', startedAt: 1 },
      durationMs: 100,
      requests: [
        {
          request: fakeReq('Bad'),
          status: 500,
          passed: false,
          durationMs: 50,
          bodyBytes: 0,
        } as RequestRunResult,
      ],
      summary: { total: 1, passed: 0, failed: 1, errored: 0 },
    };
    const xml = renderJUnitXml(result);
    expect(xml).toContain('<failure message="HTTP 500"');
  });

  it('renders an error testcase for network errors', () => {
    const result: RunResult = {
      meta: { collectionName: 'My', collectionDir: '/x', startedAt: 1 },
      durationMs: 100,
      requests: [
        {
          request: fakeReq('Net'),
          status: 0,
          passed: false,
          durationMs: 10,
          bodyBytes: 0,
          errorMessage: 'connect ECONNREFUSED',
        } as RequestRunResult,
      ],
      summary: { total: 1, passed: 0, failed: 0, errored: 1 },
    };
    const xml = renderJUnitXml(result);
    expect(xml).toContain('<error message="connect ECONNREFUSED"');
  });

  it('escapes XML special characters in names and messages', () => {
    const result: RunResult = {
      meta: { collectionName: 'A & B <C>', collectionDir: '/x', startedAt: 1 },
      durationMs: 0,
      requests: [
        {
          request: fakeReq('"name" with <tags>'),
          status: 200,
          passed: true,
          durationMs: 0,
          bodyBytes: 0,
        } as RequestRunResult,
      ],
      summary: { total: 1, passed: 1, failed: 0, errored: 0 },
    };
    const xml = renderJUnitXml(result);
    expect(xml).toContain('A &amp; B &lt;C&gt;');
    expect(xml).toContain('&quot;name&quot; with &lt;tags&gt;');
  });

  it('reports aggregate counts in <testsuites> and <testsuite>', () => {
    const result: RunResult = {
      meta: { collectionName: 'agg', collectionDir: '/x', startedAt: 1 },
      durationMs: 1500,
      requests: [],
      summary: { total: 5, passed: 3, failed: 1, errored: 1 },
    };
    const xml = renderJUnitXml(result);
    expect(xml).toContain('tests="5" failures="1" errors="1" time="1.500"');
  });
});
