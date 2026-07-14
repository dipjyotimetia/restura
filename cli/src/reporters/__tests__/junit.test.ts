import { describe, expect, it } from 'vitest';
import type { LoadedRequest } from '../../runner/collectionLoader';
import { renderJUnitXml } from '../junit';
import type { RequestRunResult, RunResult } from '../types';

const fakeReq = (name: string): LoadedRequest => ({
  filePath: '/x/y.http.yaml',
  relativePath: 'y.http.yaml',
  folderPath: [],
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

  it('disambiguates data-driven iterations in testcase names', () => {
    const result: RunResult = {
      meta: { collectionName: 'Data', collectionDir: '/x', startedAt: 1 },
      durationMs: 10,
      requests: [
        {
          request: fakeReq('Get'),
          status: 200,
          passed: true,
          durationMs: 5,
          bodyBytes: 0,
          iteration: 0,
        } as RequestRunResult,
        {
          request: fakeReq('Get'),
          status: 200,
          passed: true,
          durationMs: 5,
          bodyBytes: 0,
          iteration: 1,
        } as RequestRunResult,
      ],
      summary: { total: 2, passed: 2, failed: 0, errored: 0 },
    };
    const xml = renderJUnitXml(result);
    expect(xml).toContain('name="Get [iter 0]"');
    expect(xml).toContain('name="Get [iter 1]"');
  });

  it('includes failed-assertion detail in the failure body', () => {
    const result: RunResult = {
      meta: { collectionName: 'Asserts', collectionDir: '/x', startedAt: 1 },
      durationMs: 10,
      requests: [
        {
          request: fakeReq('Check'),
          status: 200,
          passed: false,
          durationMs: 5,
          bodyBytes: 0,
          assertions: [
            { name: 'status is 200', passed: true },
            { name: 'has name field', passed: false, error: 'expected undefined to exist' },
          ],
        } as RequestRunResult,
      ],
      summary: { total: 1, passed: 0, failed: 1, errored: 0 },
    };
    const xml = renderJUnitXml(result);
    // status is 2xx but an assertion failed — message must reflect the assertion,
    // not a misleading "HTTP 200".
    expect(xml).toContain('<failure message="1 assertion(s) failed"');
    expect(xml).toContain('has name field: expected undefined to exist');
    expect(xml).not.toContain('HTTP 200');
  });

  it('strips XML-illegal control characters from messages', () => {
    const result: RunResult = {
      meta: { collectionName: 'Ctrl', collectionDir: '/x', startedAt: 1 },
      durationMs: 0,
      requests: [
        {
          request: fakeReq('Boom'),
          status: 0,
          passed: false,
          durationMs: 0,
          bodyBytes: 0,
          errorMessage: 'bad\x00byte\x07here',
        } as RequestRunResult,
      ],
      summary: { total: 1, passed: 0, failed: 0, errored: 1 },
    };
    const xml = renderJUnitXml(result);
    expect(xml).toContain('message="badbytehere"');
    expect(xml).not.toMatch(/[\x00-\x08]/);
  });

  it('emits a testsuite timestamp from startedAt', () => {
    const result: RunResult = {
      meta: { collectionName: 'Ts', collectionDir: '/x', startedAt: 1700000000000 },
      durationMs: 0,
      requests: [],
      summary: { total: 0, passed: 0, failed: 0, errored: 0 },
    };
    const xml = renderJUnitXml(result);
    expect(xml).toContain(`timestamp="${new Date(1700000000000).toISOString()}"`);
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
