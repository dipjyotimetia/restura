// Static wiring lint for .claude/skills — catches the "skill silently can't do
// what its body says" class of bug: an `allowed-tools` list that omits `Skill`
// while the body invokes another skill, omits `Agent`/`Task` while the body
// dispatches subagents, or references agents/skills/files that do not exist.
// Regexes are deliberately conservative (backticked tokens only) so prose does
// not produce false positives.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const SKILLS_DIR = join(ROOT, '.claude', 'skills');
const AGENTS_DIR = join(ROOT, '.claude', 'agents');

// Slash tokens that are Claude Code built-in commands, plugin commands, or
// filesystem/URL paths — never local skill references.
const NON_SKILL_SLASH = new Set([
  'loop',
  'help',
  'clear',
  'compact',
  'goal',
  'schedule',
  'security-review',
  'ultrareview',
  'review',
  'init',
  'model',
  'config',
  'agents',
  'hooks',
  'mcp',
  'plugin',
  'memory',
  'tmp',
]);

// statSync follows symlinks, so vendored skills linked from .agents/skills count.
const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();

const skillNames = readdirSync(SKILLS_DIR).filter(
  (n) => isDir(join(SKILLS_DIR, n)) && existsSync(join(SKILLS_DIR, n, 'SKILL.md'))
);
const skillSet = new Set(skillNames);
const agentNames = new Set(
  readdirSync(AGENTS_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace(/\.md$/, ''))
);

function splitFrontmatter(src: string): { fm: string; body: string } {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  return m ? { fm: m[1] ?? '', body: m[2] ?? '' } : { fm: '', body: src };
}

function allowedTools(fm: string): string[] | null {
  const m = fm.match(/^allowed-tools:\s*(.+)$/m);
  if (!m) return null;
  return (m[1] ?? '')
    .split(/[,\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function mdFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (isDir(p)) out.push(...mdFiles(p));
    else if (entry.endsWith('.md')) out.push(p);
  }
  return out;
}

/** Backticked `/name` (optionally `/name args`) at the start of a code span. */
function slashRefs(body: string): string[] {
  const refs: string[] = [];
  for (const m of body.matchAll(/`\/([a-z][a-z0-9-]*)(?=[`\s])/g)) refs.push(m[1] ?? '');
  return refs;
}

function invokedSkills(name: string, body: string): string[] {
  const found = new Set<string>();
  for (const m of body.matchAll(/\binvoke the `\/?([a-z][a-z0-9-]*)` skill/gi))
    found.add(m[1] ?? '');
  for (const m of body.matchAll(/\brun the (?:[a-z-]+ )?`\/?([a-z][a-z0-9-]*)` skill/gi))
    found.add(m[1] ?? '');
  for (const m of body.matchAll(/Skill tool with [`"]([a-z][a-z0-9-]*)[`"]/g))
    found.add(m[1] ?? '');
  for (const ref of slashRefs(body)) if (skillSet.has(ref)) found.add(ref);
  found.delete(name);
  return [...found].filter((s) => skillSet.has(s));
}

function dispatchesSubagents(body: string): boolean {
  if (/\b(?:Task|Agent) (?:calls?|tool)\b/.test(body)) return true;
  for (const m of body.matchAll(/`(restura-[a-z-]+)`/g))
    if (agentNames.has(m[1] ?? '')) return true;
  return /\b(?:spawn|dispatch)\w*\b[^.\n]{0,80}\bsub-?agents?\b/i.test(body);
}

const skills = skillNames.map((name) => {
  const path = join(SKILLS_DIR, name, 'SKILL.md');
  const { fm, body } = splitFrontmatter(readFileSync(path, 'utf8'));
  return { name, path, fm, body, tools: allowedTools(fm) };
});

describe('.claude/skills wiring lint', () => {
  it('finds skills to lint', () => {
    expect(skills.length).toBeGreaterThan(5);
  });

  it.each(skills)('$name: allowed-tools includes Skill when the body invokes skills', (s) => {
    if (!s.tools) return;
    const invoked = invokedSkills(s.name, s.body);
    if (invoked.length === 0) return;
    expect(
      s.tools.includes('Skill'),
      `${s.name} invokes ${invoked.join(', ')} but allowed-tools lacks Skill`
    ).toBe(true);
  });

  it.each(skills)('$name: allowed-tools includes Agent/Task when the body dispatches', (s) => {
    if (!s.tools || !dispatchesSubagents(s.body)) return;
    expect(
      s.tools.includes('Agent') || s.tools.includes('Task'),
      `${s.name} dispatches subagents but allowed-tools lacks Agent/Task`
    ).toBe(true);
  });

  it.each(skills)('$name: every referenced restura-* name is an agent or skill', (s) => {
    const unknown = [...s.body.matchAll(/`(restura-[a-z-]+)`/g)]
      .map((m) => m[1] ?? '')
      .filter((n) => !agentNames.has(n) && !skillSet.has(n));
    expect(unknown).toEqual([]);
  });

  it.each(skills)('$name: every /slash skill reference resolves', (s) => {
    const dangling = slashRefs(s.body).filter((r) => !skillSet.has(r) && !NON_SKILL_SLASH.has(r));
    expect(dangling).toEqual([]);
  });

  it.each(skills)('$name: relative links and references/ paths resolve', (s) => {
    const skillRoot = join(SKILLS_DIR, s.name);
    const missing: string[] = [];
    for (const file of mdFiles(skillRoot)) {
      // Fenced code blocks hold illustrative templates, not real links.
      const src = readFileSync(file, 'utf8').replace(/^```[\s\S]*?^```/gm, '');
      const rel = file.slice(skillRoot.length + 1);
      for (const m of src.matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = (m[1] ?? '').split('#')[0] ?? '';
        if (!target || /^[a-z]+:/i.test(target) || target.startsWith('/')) continue;
        if (!existsSync(resolve(dirname(file), target))) missing.push(`${rel}: ${target}`);
      }
      // `references/x.md` resolves against this skill, or against another skill
      // the same file names in backticks (e.g. "invoke `restura-production-checks`
      // and read its `references/docs-parity.md`").
      const named = [...src.matchAll(/`\/?([a-z][a-z0-9-]*)`/g)]
        .map((x) => x[1] ?? '')
        .filter((n) => skillSet.has(n));
      for (const m of src.matchAll(/\breferences\/[A-Za-z0-9_.-]+\.md\b/g)) {
        const ref = m[0];
        const candidates = [skillRoot, ...named.map((n) => join(SKILLS_DIR, n))];
        if (!candidates.some((c) => existsSync(join(c, ref)))) missing.push(`${rel}: ${ref}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

// Backticked repo paths (`electron/main/ipc/ipc-validators.ts`) in skills and
// agents must exist: a moved file leaves every agent that loads the skill
// working from a wrong map. Paths with placeholders (`<name>`, `*`, `{a,b}`)
// are illustrative and skipped; a path may also be relative to its skill dir
// (e.g. a vendored skill's own `scripts/`).
const PATH_ROOTS =
  'src|shared|worker|electron|cli|scripts|tests|docs|docs-site|e2e|e2e-electron|echo|echo-local|\\.github';
const REPO_PATH_RE = new RegExp(`\`((?:${PATH_ROOTS})/[A-Za-z0-9_./<>*{}$-]+\\.[a-z]{2,5})\``, 'g');

const docFiles = [
  ...skillNames.flatMap((n) =>
    mdFiles(join(SKILLS_DIR, n)).map((f) => ({ file: f, base: join(SKILLS_DIR, n) }))
  ),
  ...[...agentNames].map((n) => ({ file: join(AGENTS_DIR, `${n}.md`), base: AGENTS_DIR })),
];

describe('.claude skills/agents path references', () => {
  it('every backticked repo path exists', () => {
    const missing: string[] = [];
    for (const { file, base } of docFiles) {
      for (const m of readFileSync(file, 'utf8').matchAll(REPO_PATH_RE)) {
        const p = m[1] ?? '';
        if (/[<>*{}$]|\.\.\./.test(p)) continue;
        if (existsSync(join(ROOT, p)) || existsSync(join(base, p))) continue;
        missing.push(`${file.slice(ROOT.length + 1)}: ${p}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
