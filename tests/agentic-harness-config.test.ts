import { readFileSync } from 'node:fs';
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

describe('agentic harness package scripts', () => {
  it.each(['test:coverage', 'test:ci'])('%s generates sandbox libraries first', (name) => {
    expect(packageJson.scripts[name]).toMatch(
      /^node scripts\/ensure-sandbox-libs\.mjs && vitest run --coverage/
    );
  });

  it('makes validate coverage-aware', () => {
    expect(packageJson.scripts.validate).toContain('npm run test:ci');
    expect(packageJson.scripts.validate).not.toContain('npm run test:run');
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
