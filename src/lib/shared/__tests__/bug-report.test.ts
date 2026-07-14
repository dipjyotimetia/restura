import { beforeEach, describe, expect, it } from 'vitest';
import {
  type BugReportDiagnostics,
  buildBugReportMarkdown,
  buildGitHubBugReportUrl,
  clearRuntimeErrorsForTests,
  getRuntimeErrors,
  recordRuntimeError,
} from '../bug-report';

const diagnostics: BugReportDiagnostics = {
  appVersion: '1.4.0',
  platform: 'web',
  operatingSystem: 'macOS',
  browser: 'Chrome 130',
  route: '#/http',
  capturedAt: '2026-07-11T10:00:00.000Z',
  runtimeErrors: [{ message: 'Request failed for https://api.example.com/path?token=redacted' }],
};

describe('bug report formatting', () => {
  beforeEach(() => clearRuntimeErrorsForTests());

  it('builds markdown matching the bug issue template with selected diagnostics', () => {
    const markdown = buildBugReportMarkdown({
      title: 'Response pane crashes',
      description: 'Opening a binary response crashes the renderer.',
      steps: '1. Send a request\n2. Open the response pane',
      expected: 'The response should render.',
      actual: 'The renderer becomes blank.',
      diagnostics,
    });

    expect(markdown).toContain(
      '## 🔍 Description\n\nOpening a binary response crashes the renderer.'
    );
    expect(markdown).toContain('## 📋 Steps to Reproduce\n\n1. Send a request');
    expect(markdown).toContain('## ✅ Expected Behavior\n\nThe response should render.');
    expect(markdown).toContain('## ❌ Actual Behavior\n\nThe renderer becomes blank.');
    expect(markdown).toContain('- [x] 🌐 Web Client (Cloudflare Pages)');
    expect(markdown).toContain('- [ ] 🖥️ Electron Desktop App');
    expect(markdown).toContain('- Restura Version: 1.4.0');
    expect(markdown).toContain('### Diagnostic context');
    expect(markdown).toContain('https://api.example.com/path');
    expect(markdown).not.toContain('token=redacted');
  });

  it('omits diagnostics when the user excludes them', () => {
    const markdown = buildBugReportMarkdown({
      title: 'A bug',
      description: 'It broke.',
    });

    expect(markdown).toContain('## 🚨 Error Logs\n\n```\nNo diagnostics included.\n```');
    expect(markdown).not.toContain('### Diagnostic context');
  });

  it('opens the canonical bug template with a bug label and encoded body', () => {
    const url = new URL(buildGitHubBugReportUrl({ title: 'A bug', description: 'It broke.' }));

    expect(url.pathname).toBe('/dipjyotimetia/restura/issues/new');
    expect(url.searchParams.get('template')).toBe('bug_report.md');
    expect(url.searchParams.get('labels')).toBe('bug');
    expect(url.searchParams.get('title')).toBe('🐛 [BUG] A bug');
    expect(url.searchParams.get('body')).toContain('## 🔍 Description');
  });

  it('keeps a bounded, sanitized runtime error history', () => {
    recordRuntimeError({
      message: 'Failed https://example.com/x?api_key=secret with api_key=secret',
      stack: 'Error: token=secret',
    });
    for (let index = 0; index < 24; index += 1) recordRuntimeError({ message: `error ${index}` });

    const errors = getRuntimeErrors();
    expect(errors).toHaveLength(25);
    expect(errors[0]?.message).toContain('api_key=[redacted]');
    expect(errors.some((error) => error.message.includes('api_key=secret'))).toBe(false);
    expect(errors.some((error) => error.message.includes('api_key=[redacted]'))).toBe(true);
  });
});
