import * as assert from 'node:assert';
import * as vscode from 'vscode';

const EXT_ID = 'dipjyotimetia.restura-vscode';

async function waitFor(predicate, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

suite('Restura extension', () => {
  test('activates and registers its commands', async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, 'extension is installed');
    await ext.activate();
    const cmds = await vscode.commands.getCommands(true);
    for (const id of ['restura.sendRequest', 'restura.runRequestAsTest', 'restura.refreshTests']) {
      assert.ok(cmds.includes(id), `command ${id} registered`);
    }
  });

  test('produces a schema diagnostic for an invalid request file', async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, 'workspace folder open');
    const uri = vscode.Uri.joinPath(folder.uri, 'broken-request.yaml');
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);

    const hasDiag = await waitFor(() => vscode.languages.getDiagnostics(uri).length > 0);
    assert.ok(hasDiag, 'broken-request.yaml has at least one diagnostic');
    const diags = vscode.languages.getDiagnostics(uri);
    assert.ok(
      diags.some((d) => d.source === 'restura'),
      'diagnostic is from restura'
    );
  });

  test('does not flag a valid request file', async () => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const uri = vscode.Uri.joinPath(folder.uri, 'get-anything.yaml');
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);
    // Give the debounced validator a moment, then assert no restura diagnostics.
    await new Promise((r) => setTimeout(r, 800));
    const diags = vscode.languages.getDiagnostics(uri).filter((d) => d.source === 'restura');
    assert.strictEqual(diags.length, 0, 'valid file has no restura diagnostics');
  });
});
