import * as vscode from 'vscode';
import { validateOcDocument } from './validate';

function isYamlDoc(doc: vscode.TextDocument): boolean {
  if (doc.languageId === 'yaml') return true;
  const p = doc.uri.fsPath.toLowerCase();
  return p.endsWith('.yaml') || p.endsWith('.yml');
}

function refresh(doc: vscode.TextDocument, collection: vscode.DiagnosticCollection): void {
  if (doc.uri.scheme !== 'file' || !isYamlDoc(doc)) return;

  const issues = validateOcDocument(doc.uri.fsPath, doc.getText());
  if (issues.length === 0) {
    collection.delete(doc.uri);
    return;
  }

  const diagnostics = issues.map((issue) => {
    const lineNo = Math.min(issue.line, Math.max(0, doc.lineCount - 1));
    const textLine = doc.lineAt(lineNo);
    const range = new vscode.Range(
      lineNo,
      textLine.firstNonWhitespaceCharacterIndex,
      lineNo,
      textLine.range.end.character
    );
    const diag = new vscode.Diagnostic(
      range,
      `${issue.message} (at ${issue.pathLabel})`,
      vscode.DiagnosticSeverity.Error
    );
    diag.source = 'restura';
    return diag;
  });
  collection.set(doc.uri, diagnostics);
}

/**
 * Offering 1 — OpenCollection language support. Registers a DiagnosticCollection
 * driven by the per-request element schemas (`validateOcDocument`). Root
 * collection files are handled by the `yamlValidation` JSON-Schema contribution
 * in package.json, so they're skipped here.
 */
export function registerDiagnostics(context: vscode.ExtensionContext): void {
  const collection = vscode.languages.createDiagnosticCollection('restura');
  context.subscriptions.push(collection);

  const debounceTimers = new Map<string, NodeJS.Timeout>();
  const debouncedRefresh = (doc: vscode.TextDocument): void => {
    const key = doc.uri.toString();
    const existing = debounceTimers.get(key);
    if (existing) clearTimeout(existing);
    debounceTimers.set(
      key,
      setTimeout(() => {
        debounceTimers.delete(key);
        refresh(doc, collection);
      }, 300)
    );
  };

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((doc) => refresh(doc, collection)),
    vscode.workspace.onDidSaveTextDocument((doc) => refresh(doc, collection)),
    vscode.workspace.onDidChangeTextDocument((e) => debouncedRefresh(e.document)),
    vscode.workspace.onDidCloseTextDocument((doc) => collection.delete(doc.uri)),
    new vscode.Disposable(() => {
      for (const timer of debounceTimers.values()) clearTimeout(timer);
      debounceTimers.clear();
    })
  );

  // Validate already-open editors at activation.
  for (const doc of vscode.workspace.textDocuments) refresh(doc, collection);
}
