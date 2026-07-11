const GITHUB_BUG_REPORT_URL = 'https://github.com/dipjyotimetia/restura/issues/new';
const MAX_RUNTIME_ERRORS = 25;
const MAX_DIAGNOSTIC_TEXT_LENGTH = 2_000;

export type BugReportPlatform = 'web' | 'electron' | 'self-hosted';

export interface BugReportRuntimeError {
  message: string;
  stack?: string;
  source?: string;
  timestamp?: string;
}

export interface BugReportRequestLog {
  timestamp: string;
  protocol: string;
  method: string;
  url: string;
  status: number;
  durationMs: number;
  error?: string;
}

export interface BugReportDiagnostics {
  appVersion: string;
  platform: BugReportPlatform;
  operatingSystem: string;
  browser: string;
  route: string;
  capturedAt: string;
  runtimeErrors: BugReportRuntimeError[];
  requestLogs?: BugReportRequestLog[];
}

export interface BugReportDraft {
  title: string;
  description: string;
  steps?: string;
  expected?: string;
  actual?: string;
  diagnostics?: BugReportDiagnostics;
  hasScreenshot?: boolean;
}

let runtimeErrors: BugReportRuntimeError[] = [];

function trimDiagnosticText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_DIAGNOSTIC_TEXT_LENGTH);
}

/** Removes URL query, credentials, and fragment before diagnostics leave the app. */
export function sanitizeBugReportText(value: string): string {
  const withSafeUrls = value.replace(/https?:\/\/[^\s)'"`]+/g, (rawUrl) => {
    try {
      const url = new URL(rawUrl);
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch {
      return rawUrl.replace(/[?#][^\s)'"`]*/, '');
    }
  });

  return trimDiagnosticText(withSafeUrls)
    .replace(
      /\b(api[_-]?key|token|authorization|password|secret)\s*[=:]\s*[^\s,;]+/gi,
      '$1=[redacted]'
    )
    .slice(0, MAX_DIAGNOSTIC_TEXT_LENGTH);
}

export function recordRuntimeError(error: BugReportRuntimeError): void {
  runtimeErrors = [
    ...runtimeErrors,
    {
      message: sanitizeBugReportText(error.message),
      ...(error.stack ? { stack: sanitizeBugReportText(error.stack) } : {}),
      ...(error.source ? { source: sanitizeBugReportText(error.source) } : {}),
      timestamp: error.timestamp ?? new Date().toISOString(),
    },
  ].slice(-MAX_RUNTIME_ERRORS);
}

export function getRuntimeErrors(): BugReportRuntimeError[] {
  return runtimeErrors.map((error) => ({ ...error }));
}

/** Test-only reset for the module-level, in-memory diagnostic ring. */
export function clearRuntimeErrorsForTests(): void {
  runtimeErrors = [];
}

/** Installs non-invasive listeners alongside telemetry's global handlers. */
export function installBugReportErrorCapture(): void {
  if (typeof window === 'undefined') return;
  window.addEventListener('error', (event) => {
    recordRuntimeError({
      message: event.message || 'Unhandled window error',
      ...(event.error instanceof Error && event.error.stack ? { stack: event.error.stack } : {}),
      source: event.filename,
    });
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    recordRuntimeError({
      message: reason instanceof Error ? reason.message : String(reason),
      ...(reason instanceof Error && reason.stack ? { stack: reason.stack } : {}),
      source: 'unhandledrejection',
    });
  });
}

function section(title: string, value: string | undefined, placeholder: string): string {
  return `${title}\n\n${value?.trim() || placeholder}`;
}

function checkbox(checked: boolean, label: string): string {
  return `- [${checked ? 'x' : ' '}] ${label}`;
}

function formatDiagnostics(diagnostics: BugReportDiagnostics): string {
  const errors = diagnostics.runtimeErrors.map((error) => {
    const context = [error.source, error.stack].filter(Boolean).join(' — ');
    return `- ${sanitizeBugReportText(error.message)}${context ? ` (${sanitizeBugReportText(context)})` : ''}`;
  });
  const requests = (diagnostics.requestLogs ?? []).map((entry) => {
    const suffix = entry.error ? ` — ${sanitizeBugReportText(entry.error)}` : '';
    return `- ${entry.protocol.toUpperCase()} ${entry.method} ${sanitizeBugReportText(entry.url)} → ${entry.status} (${entry.durationMs}ms)${suffix}`;
  });

  return [
    '### Diagnostic context',
    '',
    `- Captured: ${diagnostics.capturedAt}`,
    `- Route: ${sanitizeBugReportText(diagnostics.route) || '[unknown]'}`,
    ...(errors.length ? ['', '#### Recent runtime errors', '', ...errors] : []),
    ...(requests.length ? ['', '#### Recent request history', '', ...requests] : []),
  ].join('\n');
}

/** Builds the GitHub issue body in the same order and vocabulary as bug_report.md. */
export function buildBugReportMarkdown(draft: BugReportDraft): string {
  const diagnostics = draft.diagnostics;
  const platform = diagnostics?.platform;
  const hasDiagnostics = diagnostics !== undefined;

  return [
    section('## 🔍 Description', draft.description, '<!-- Describe the problem -->'),
    '',
    section('## 📋 Steps to Reproduce', draft.steps, '<!-- Add reproducible steps -->'),
    '',
    section('## ✅ Expected Behavior', draft.expected, '<!-- What should happen instead? -->'),
    '',
    section('## ❌ Actual Behavior', draft.actual, '<!-- What actually happened? -->'),
    '',
    '## 📸 Screenshots',
    '',
    draft.hasScreenshot
      ? '> A screenshot was copied to your clipboard. Paste it below with Cmd/Ctrl+V.'
      : '<!-- No screenshot included -->',
    '',
    '## 🌍 Environment',
    '',
    '**Platform:**',
    '',
    checkbox(platform === 'web', '🌐 Web Client (Cloudflare Pages)'),
    checkbox(platform === 'electron', '🖥️ Electron Desktop App'),
    checkbox(platform === 'self-hosted', '📦 Self-hosted Node/Docker'),
    '',
    '**System Information:**',
    '',
    `- OS: ${diagnostics?.operatingSystem || '[not included]'}`,
    `- Browser: ${diagnostics?.browser || '[not included]'}`,
    '- Node Version: [not included]',
    `- Restura Version: ${diagnostics?.appVersion || '[not included]'}`,
    '',
    '## 🚨 Error Logs',
    '',
    '```',
    hasDiagnostics ? 'See Diagnostic context below.' : 'No diagnostics included.',
    '```',
    ...(diagnostics ? ['', formatDiagnostics(diagnostics)] : []),
    '',
    '## 📝 Additional Context',
    '',
    '<!-- Add any other relevant information -->',
    '',
    '## 💡 Possible Solution',
    '',
    '<!-- Optional: If you have ideas on how to fix this -->',
  ].join('\n');
}

export function buildGitHubBugReportUrl(draft: BugReportDraft): string {
  const title = draft.title.trim() || 'Untitled report';
  const params = new URLSearchParams({
    template: 'bug_report.md',
    labels: 'bug',
    title: `🐛 [BUG] ${title}`,
    body: buildBugReportMarkdown(draft),
  });
  return `${GITHUB_BUG_REPORT_URL}?${params.toString()}`;
}
