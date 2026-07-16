import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

const requiredSkills = [
  'restura-feature-dev',
  'restura-production-checks',
  'verify-ui-change',
  'fix-until-green',
  'ship-check',
  'docs-sync',
  'new-protocol',
  'babysit-prs',
  'triage-maintenance',
  'skill-report',
];

const requiredAgents = [
  'restura-security-auditor',
  'restura-parity-checker',
  'restura-docs-steward',
];

function workflowJob(workflow: string, name: string): string {
  const start = workflow.indexOf(`  ${name}:`);
  if (start < 0) return '';
  const remainder = workflow.slice(start + name.length + 3);
  const next = remainder.search(/^  [a-zA-Z0-9_-]+:/m);
  return next < 0 ? workflow.slice(start) : workflow.slice(start, start + name.length + 3 + next);
}

describe('agentic harness package scripts', () => {
  it.each(['test:coverage', 'test:ci'])('%s generates sandbox libraries first', (name) => {
    expect(packageJson.scripts[name]).toMatch(
      /^node scripts\/ensure-sandbox-libs\.mjs && vitest run --coverage/
    );
  });

  it('makes validate coverage-aware', () => {
    expect(packageJson.scripts.validate).toBe('node scripts/ci/run-validation.mjs');
    expect(packageJson.scripts['validate:checks']).toContain('npm run test:ci');
    expect(packageJson.scripts['validate:checks']).not.toContain('npm run test:run');
  });

  it('keeps agent and CI control-plane tooling outside the product coverage budget', () => {
    const config = readFileSync(resolve(process.cwd(), 'vitest.config.ts'), 'utf8');
    expect(config).toContain("'.codex/'");
    expect(config).toContain("'scripts/ci/'");
  });
});

describe('Codex repository discovery', () => {
  it.each(requiredSkills)('publishes the %s Codex skill', (name) => {
    const text = readFileSync(resolve(process.cwd(), `.agents/skills/${name}/SKILL.md`), 'utf8');
    expect(text).toMatch(new RegExp(`^---\\nname: ${name}\\n`, 'm'));
    expect(text).toMatch(/^description: .+/m);
  });

  it.each(requiredAgents)('publishes the %s read-only Codex agent', (name) => {
    const text = readFileSync(resolve(process.cwd(), `.codex/agents/${name}.toml`), 'utf8');
    expect(text).toContain(`name = "${name}"`);
    expect(text).toContain('sandbox_mode = "read-only"');
    expect(text).toContain('developer_instructions = """');
  });

  it('keeps the production gate and platform/security review invariants discoverable', () => {
    const productionChecks = readFileSync(
      resolve(process.cwd(), '.agents/skills/restura-production-checks/SKILL.md'),
      'utf8'
    );
    const shipCheck = readFileSync(
      resolve(process.cwd(), '.agents/skills/ship-check/SKILL.md'),
      'utf8'
    );
    const guidance = `${productionChecks}\n${shipCheck}`;

    expect(guidance).toContain('npm run validate');
    expect(guidance).toContain('coverage');
    expect(guidance).toContain('Cloudflare Worker');
    expect(guidance).toContain('self-hosted Node');
    expect(guidance).toContain('Electron');
    expect(guidance).toContain('restura-security-auditor');
    expect(guidance).toContain('restura-parity-checker');
    expect(guidance).toContain('restura-docs-steward');
    expect(guidance).toContain('live GitHub ruleset');
  });

  it('pins Chrome DevTools MCP with a root-resolved cache and bounded timeouts', () => {
    const config = readFileSync(resolve(process.cwd(), '.codex/config.toml'), 'utf8');
    const launcher = readFileSync(
      resolve(process.cwd(), '.codex/run-chrome-devtools-mcp.mjs'),
      'utf8'
    );

    expect(config).toContain('command = "node"');
    expect(config).toContain('args = [".codex/run-chrome-devtools-mcp.mjs"]');
    expect(config).toContain('startup_timeout_sec = 30');
    expect(config).toContain('tool_timeout_sec = 120');
    expect(launcher).toContain('chrome-devtools-mcp@1.6.0');
    expect(launcher).toContain("'.codex', 'cache', 'npm'");
    expect(`${config}\n${launcher}`).not.toContain('@latest');
  });
});

describe('complete CI merge gate', () => {
  const ci = readFileSync(resolve(process.cwd(), '.github/workflows/ci.yml'), 'utf8');

  it('aggregates every required validation and shipping surface', () => {
    expect(ci).toContain('  merge-gate:');
    expect(ci).toContain('    name: merge-gate');
    expect(ci).toContain('    if: always()');
    expect(ci).toContain(
      '    needs: [validate, self-host-smoke, electron-smoke, e2e, e2e-extension, e2e-electron, vscode-extension-e2e, docs]'
    );
    expect(ci).toContain('NEEDS_JSON: ${{ toJSON(needs) }}');
    expect(ci).toContain('node scripts/ci/assert-merge-gate.mjs');
    expect(ci).toContain('electron-smoke,e2e-electron,vscode-extension-e2e');
    const selfHost = workflowJob(ci, 'self-host-smoke');
    expect(selfHost).toContain('docker build');
    expect(selfHost).toContain('docker run');
    expect(selfHost).toContain('/health');
    expect(selfHost).toContain('http://127.0.0.1:31337/');
  });

  it('runs required platform jobs for pushes to main as well as pull requests', () => {
    for (const name of [
      'electron-smoke',
      'e2e',
      'e2e-extension',
      'e2e-electron',
      'vscode-extension-e2e',
    ]) {
      expect(workflowJob(ci, name), `${name} remains pull-request-only`).not.toMatch(
        /\n    if: (?:\$\{\{ )?github\.event_name == 'pull_request'/
      );
    }
  });

  it('limits Dependabot skips and ignored install scripts to pull-request runs', () => {
    for (const name of ['electron-smoke', 'e2e-electron', 'vscode-extension-e2e']) {
      expect(workflowJob(ci, name)).toContain(
        "github.event_name != 'pull_request' || github.actor != 'dependabot[bot]'"
      );
    }
    expect(ci).toContain(
      "github.event_name == 'pull_request' && github.actor == 'dependabot[bot]' && ' --ignore-scripts'"
    );
    expect(workflowJob(ci, 'merge-gate')).toContain(
      "github.event_name == 'pull_request' && github.actor == 'dependabot[bot]' && 'electron-smoke,e2e-electron,vscode-extension-e2e'"
    );
  });
});

describe('agent runtime build-context isolation', () => {
  it('never sends machine-local Claude or Codex state to Docker builds', () => {
    const dockerignore = readFileSync(resolve(process.cwd(), '.dockerignore'), 'utf8');
    for (const path of [
      '.claude/settings.local.json',
      '.claude/metrics',
      '.codex/cache',
      '.codex/metrics',
    ]) {
      expect(dockerignore).toContain(path);
    }
  });
});

describe('agentic harness documentation truth', () => {
  const agents = readFileSync(resolve(process.cwd(), 'AGENTS.md'), 'utf8');
  const claude = readFileSync(resolve(process.cwd(), 'CLAUDE.md'), 'utf8');
  const ciDocs = readFileSync(resolve(process.cwd(), 'docs/CI_CD.md'), 'utf8');
  const quickstart = readFileSync(resolve(process.cwd(), 'openwiki/quickstart.md'), 'utf8');
  const testing = readFileSync(resolve(process.cwd(), 'openwiki/testing/index.md'), 'utf8');
  const operations = readFileSync(resolve(process.cwd(), 'openwiki/operations/index.md'), 'utf8');
  const readme = readFileSync(resolve(process.cwd(), 'README.md'), 'utf8');
  const devSetup = readFileSync(
    resolve(process.cwd(), 'docs-site/src/content/docs/contributing/dev-setup.mdx'),
    'utf8'
  );
  const contractCi = readFileSync(
    resolve(process.cwd(), 'docs-site/src/content/docs/testing/contract-and-ci.mdx'),
    'utf8'
  );

  it('documents local coverage validation, the full CI gate, and exact-SHA release proof', () => {
    for (const text of [agents, claude, ciDocs, quickstart, testing, operations]) {
      expect(text).toContain('npm run validate');
      expect(text).toContain('merge-gate');
    }
    for (const text of [agents, claude, ciDocs]) {
      expect(text).toContain('exact candidate SHA');
    }
  });

  it('documents the current uncovered-item coverage budget accurately', () => {
    expect(testing).toContain('5,226');
    expect(testing).toContain('4,378');
    expect(testing).not.toContain('lines: 80');
    expect(testing).not.toContain('zeroes all thresholds');
  });

  it('does not retain the superseded claim that local validation is all of CI', () => {
    const adr = readFileSync(
      resolve(process.cwd(), 'docs/adr/0021-maintenance-harness.md'),
      'utf8'
    );
    const siteAdr = readFileSync(
      resolve(
        process.cwd(),
        'docs-site/src/content/docs/architecture/adrs/0021-maintenance-harness.mdx'
      ),
      'utf8'
    );
    expect(quickstart).not.toContain('Full validation (matches CI)');
    expect(adr).not.toContain('Local `validate` now matches CI');
    expect(siteAdr).not.toContain('Local `validate` now matches CI');
    expect(readme).not.toContain('tests (same as CI)');
    expect(devSetup).not.toContain('The full gate:');
    expect(contractCi).not.toContain('The single CI gate');
  });

  it('keeps Claude and public validation guidance aligned with the coverage-aware gate', () => {
    const claudeSkill = readFileSync(
      resolve(process.cwd(), '.claude/skills/restura-production-checks/SKILL.md'),
      'utf8'
    );
    const claudeShipCheck = readFileSync(
      resolve(process.cwd(), '.claude/commands/ship-check.md'),
      'utf8'
    );
    const claudeGates = readFileSync(
      resolve(
        process.cwd(),
        '.claude/skills/restura-production-checks/references/verification-gates.md'
      ),
      'utf8'
    );

    for (const text of [claudeSkill, claudeShipCheck, claudeGates, devSetup, contractCi]) {
      expect(text).toContain('test:ci');
      expect(text).toContain('merge-gate');
    }
    expect(claudeSkill).toContain('5,226');
    expect(claudeSkill).toContain('4,378');
    expect(claudeSkill).not.toContain('lines 80 / functions 78 / branches 61 / statements 78');
    expect(claudeShipCheck).toContain('npm run build:docker');
    expect(claudeGates).toContain('self-host-smoke');
    expect(claudeGates).toContain('pushes to `main`');
  });

  it('keeps Codex documentation ownership and lifecycle guidance accurate', () => {
    const docsSync = readFileSync(
      resolve(process.cwd(), '.agents/skills/docs-sync/SKILL.md'),
      'utf8'
    );
    const docsParity = readFileSync(
      resolve(process.cwd(), '.agents/skills/restura-production-checks/references/docs-parity.md'),
      'utf8'
    );
    const codexReadme = readFileSync(resolve(process.cwd(), '.codex/README.md'), 'utf8');

    expect(docsSync).toContain(
      '.agents/skills/restura-production-checks/references/docs-parity.md'
    );
    for (const path of [
      'README.md',
      'openwiki/quickstart.md',
      'docs-site/src/content/docs/contributing/dev-setup.mdx',
      'docs-site/src/content/docs/testing/contract-and-ci.mdx',
    ]) {
      expect(docsParity).toContain(path);
    }
    expect(agents).toContain('.agents/skills/verify-ui-change/SKILL.md');
    expect(codexReadme).toContain('.codex/metrics/');
    expect(codexReadme).toContain('explicit `npm run validate`');
    expect(codexReadme).not.toContain('edited source files are formatted with Biome');
    expect(codexReadme).not.toContain('the stop hook runs `npm run validate`');
  });

  it('separates observed live rules from the deferred administrative recommendation', () => {
    expect(ciDocs).toContain('Currently observed live rules');
    expect(ciDocs).toContain('Deferred administrative follow-up');
    expect(ciDocs).toContain('Main protection with');
    expect(ciDocs).toContain('Copilot review for default branch');
    expect(ciDocs).toContain('require `merge-gate`');
    expect(ciDocs).toMatch(/self-hosted\s+Node image/);
  });

  it('describes manual release initiation and trusted PR-close continuation accurately', () => {
    expect(ciDocs).toContain('manually starts');
    expect(ciDocs).toContain('PR-close');
    expect(ciDocs).not.toContain('Production ships only from a\n> manually-dispatched');
  });

  it('provides a Codex harness reference', () => {
    const codexReadme = readFileSync(resolve(process.cwd(), '.codex/README.md'), 'utf8');
    expect(codexReadme).toContain('.agents/skills');
    expect(codexReadme).toContain('.codex/agents');
    expect(codexReadme).toContain('/hooks');
    expect(codexReadme).toContain('/mcp');
    expect(codexReadme).toContain('merge-gate');
  });

  it('records and publishes the architecture decision', () => {
    const adr = readFileSync(
      resolve(process.cwd(), 'docs/adr/0028-codex-agentic-harness-and-shipping-gates.md'),
      'utf8'
    );
    const siteIndex = readFileSync(
      resolve(process.cwd(), 'docs-site/src/content/docs/architecture/adrs.mdx'),
      'utf8'
    );
    const siteConfig = readFileSync(resolve(process.cwd(), 'docs-site/astro.config.mjs'), 'utf8');

    expect(adr).toContain('Codex agentic harness and shipping gates');
    expect(adr).toContain('Exact-commit release proof');
    expect(siteIndex).toContain('0028 — Codex agentic harness and shipping gates');
    expect(siteConfig).toContain('0028-codex-agentic-harness-and-shipping-gates');
  });

  it('publishes every canonical ADR number in the docs site', () => {
    const canonicalNumbers = readdirSync(resolve(process.cwd(), 'docs/adr'))
      .map((name) => name.match(/^(\d{4})-.*\.md$/)?.[1])
      .filter((number): number is string => number !== undefined);
    const siteNumbers = new Set(
      readdirSync(resolve(process.cwd(), 'docs-site/src/content/docs/architecture/adrs'))
        .map((name) => name.match(/^(\d{4})-.*\.mdx$/)?.[1])
        .filter((number): number is string => number !== undefined)
    );

    expect(canonicalNumbers.filter((number) => !siteNumbers.has(number))).toEqual([]);
  });

  it('does not track machine-local Claude settings', () => {
    const result = spawnSync(
      'git',
      ['ls-files', '--error-unmatch', '.claude/settings.local.json'],
      { cwd: process.cwd(), stdio: 'ignore' }
    );
    expect(result.status).not.toBe(0);
  });
});
