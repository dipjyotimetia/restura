import * as vscode from 'vscode';
import type { NormalizedResponse } from '../../../../shared/protocol/types';

let panel: vscode.WebviewPanel | undefined;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function statusClass(status: number): string {
  if (status >= 200 && status < 300) return 'ok';
  if (status >= 300 && status < 400) return 'redirect';
  return 'error';
}

function prettyBody(response: NormalizedResponse): string {
  if (response.bodyEncoding === 'base64') {
    return `[binary response — ${response.size} bytes, not shown]`;
  }
  const contentType = response.headers['content-type'] ?? '';
  if (contentType.includes('json')) {
    try {
      return JSON.stringify(JSON.parse(response.body), null, 2);
    } catch {
      // fall through to raw
    }
  }
  return response.body;
}

function renderHtml(
  webview: vscode.Webview,
  nonce: string,
  title: string,
  bodyHtml: string
): string {
  const csp = `default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}';`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style nonce="${nonce}">
    body { font-family: var(--vscode-editor-font-family, monospace); padding: 0 12px; color: var(--vscode-foreground); }
    h2 { font-size: 1rem; margin: 12px 0 4px; }
    .status { font-weight: 600; }
    .status.ok { color: var(--vscode-testing-iconPassed, #3fb950); }
    .status.redirect { color: var(--vscode-charts-yellow, #d29922); }
    .status.error { color: var(--vscode-testing-iconFailed, #f85149); }
    .warn { color: var(--vscode-editorWarning-foreground, #d29922); }
    table { border-collapse: collapse; width: 100%; }
    td { padding: 2px 8px; vertical-align: top; border-bottom: 1px solid var(--vscode-panel-border, #333); font-size: 0.85rem; }
    td.key { color: var(--vscode-descriptionForeground); white-space: nowrap; }
    pre { background: var(--vscode-textCodeBlock-background, #1e1e1e); padding: 10px; border-radius: 4px; overflow: auto; white-space: pre-wrap; word-break: break-word; font-size: 0.85rem; }
  </style>
  <title>${escapeHtml(title)}</title>
</head>
<body>${bodyHtml}</body>
</html>`;
}

function ensurePanel(context: vscode.ExtensionContext): vscode.WebviewPanel {
  if (panel) return panel;
  panel = vscode.window.createWebviewPanel(
    'resturaResponse',
    'Restura Response',
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    { enableScripts: false, retainContextWhenHidden: true }
  );
  // Tracked for disposal on deactivate; the listener also clears the cached ref
  // when the user closes the panel manually.
  context.subscriptions.push(panel);
  panel.onDidDispose(() => (panel = undefined), null, context.subscriptions);
  return panel;
}

function warningHtml(warnings: string[]): string {
  if (warnings.length === 0) return '';
  return `<p class="warn">⚠ ${warnings.map(escapeHtml).join('<br>⚠ ')}</p>`;
}

/** Paint `bodyHtml` into the shared response panel and reveal it. */
function paint(context: vscode.ExtensionContext, requestName: string, bodyHtml: string): void {
  const p = ensurePanel(context);
  p.title = `Response: ${requestName}`;
  p.webview.html = renderHtml(p.webview, String(Date.now()), requestName, bodyHtml);
  p.reveal(vscode.ViewColumn.Beside, true);
}

export function showResponse(
  context: vscode.ExtensionContext,
  requestName: string,
  response: NormalizedResponse,
  warnings: string[],
  url: string
): void {
  const headerRows = Object.entries(response.headers)
    .map(([k, v]) => `<tr><td class="key">${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`)
    .join('');
  paint(
    context,
    requestName,
    `
    <h2>${escapeHtml(requestName)}</h2>
    <p><span class="status ${statusClass(response.status)}">${response.status} ${escapeHtml(response.statusText)}</span> · ${response.size} bytes</p>
    <p class="key">${escapeHtml(url)}</p>
    ${warningHtml(warnings)}
    <h2>Headers</h2>
    <table>${headerRows}</table>
    <h2>Body</h2>
    <pre>${escapeHtml(prettyBody(response))}</pre>`
  );
}

export function showError(
  context: vscode.ExtensionContext,
  requestName: string,
  error: string,
  warnings: string[]
): void {
  paint(
    context,
    requestName,
    `
    <h2>${escapeHtml(requestName)}</h2>
    <p><span class="status error">Request failed</span></p>
    ${warningHtml(warnings)}
    <pre>${escapeHtml(error)}</pre>`
  );
}
