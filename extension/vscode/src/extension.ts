import type * as vscode from 'vscode';
import { registerDiagnostics } from './offering1_lang/diagnostics';
import { registerTestController } from './offering2_test/testController';
import { registerCodeLens } from './offering3_codelens/requestCodeLens';

export function activate(context: vscode.ExtensionContext): void {
  // Offering 1 — OpenCollection language support (schema diagnostics).
  registerDiagnostics(context);

  // Offering 2a — Test Explorer backed by the restura CLI (shell-out).
  registerTestController(context);

  // Offering 3 — CodeLens Send / Run test + response webview.
  registerCodeLens(context);
}

export function deactivate(): void {
  // Disposables are tracked on context.subscriptions; nothing extra to tear down.
}
