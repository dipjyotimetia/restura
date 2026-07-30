import { expect, test } from '../fixtures/gitRemote';

test.describe('Git-native merge workflow', () => {
  test('fetches over trusted local HTTPS and completes a structured conflict', async ({
    app: page,
    gitRemote,
  }) => {
    const loaded = await page.evaluate(async (directoryPath) => {
      const result = await window.electron?.collections.loadFromDirectory(directoryPath);
      if (result?.success) await window.electron?.collections.watchDirectory(directoryPath);
      return result;
    }, gitRemote.workspaceDirectory);
    if (!loaded?.success) throw new Error(`Fixture workspace did not load: ${loaded?.error}`);

    const result = await page.evaluate(async (directoryPath) => {
      const git = window.electron?.git;
      if (!git) throw new Error('Git preload API unavailable');
      const fetched = await git.fetch(directoryPath);
      if (!fetched.ok) return fetched;
      const listed = await git.branchList(directoryPath);
      if (!listed.ok) return listed;
      const incoming = listed.branches.find((branch) => branch.name === 'origin/incoming');
      if (!incoming?.oid) throw new Error('Fetched origin/incoming was not listed');
      const started = await git.startMerge(directoryPath, incoming.name, incoming.oid);
      if (!started.ok) return started;
      const state = await git.mergeState(directoryPath);
      if (!state.ok || state.state.phase !== 'conflicted') return state;
      const summary = state.state.conflicts[0];
      if (!summary) throw new Error('Expected a merge conflict');
      const detail = await git.getMergeConflict(directoryPath, summary.id);
      if (!detail.ok) return detail;
      if (!detail.conflict.incoming.content) throw new Error('Incoming content missing');
      const resolved = await git.resolveMergeConflict(directoryPath, {
        conflictId: summary.id,
        kind: 'content',
        content: detail.conflict.incoming.content,
      });
      if (!resolved.ok || resolved.state.phase !== 'ready-to-commit') return resolved;
      const committed = await git.completeMerge(directoryPath, 'Merge origin/incoming');
      if (!committed.ok) return committed;
      const pushed = await git.push(directoryPath);
      if (!pushed.ok) return pushed;
      return git.mergeState(directoryPath);
    }, gitRemote.workspaceDirectory);

    expect(result).toMatchObject({
      ok: true,
      state: { phase: 'idle', branch: 'main', dirty: false },
    });
  });
});
