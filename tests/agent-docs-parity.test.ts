// CLAUDE.md (Claude Code) and AGENTS.md (Codex) document the same repo for two
// agents. Every top-level `##` section in CLAUDE.md must exist in AGENTS.md so
// one file cannot silently drift ahead of the other.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// CLAUDE.md headings that are intentionally Claude-only, mapped to the
// AGENTS.md heading that carries the Codex-framed equivalent (or null when
// there is deliberately none).
const CLAUDE_ONLY: Record<string, string | null> = {
  'Summary instructions (for context compaction)': 'When summarizing this conversation',
};

const headings = (file: string) =>
  readFileSync(join(process.cwd(), file), 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^## /.test(l))
    .map((l) => l.slice(3).trim());

describe('agent docs parity (CLAUDE.md ⇄ AGENTS.md)', () => {
  it('every CLAUDE.md ## heading exists in AGENTS.md', () => {
    const agents = new Set(headings('AGENTS.md'));
    const missing = headings('CLAUDE.md').filter((h) => {
      if (h in CLAUDE_ONLY) {
        const equivalent = CLAUDE_ONLY[h];
        return equivalent ? !agents.has(equivalent) : false;
      }
      return !agents.has(h);
    });
    expect(missing).toEqual([]);
  });
});
