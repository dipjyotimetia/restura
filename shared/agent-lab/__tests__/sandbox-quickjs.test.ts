import { describe, expect, it } from 'vitest';
import {
  createDefaultSandboxRegistry,
  QUICKJS_SANDBOX_ID,
  QuickJsSandboxProvider,
  SANDBOX_TIMEOUT_EXIT_CODE,
} from '../sandbox-quickjs';
import { createAgentToolResolver } from '../tool-resolver';
import { createSandboxToolSourceAdapter, SandboxRegistry, sandboxToolName } from '../tools';

const provider = new QuickJsSandboxProvider();
const base = {
  language: 'javascript',
  timeoutMs: 2_000,
  network: 'disabled',
  maxOutputBytes: 4096,
} as const;

describe('QuickJS sandbox provider (#1042)', () => {
  it('runs code and captures stdout / stderr', async () => {
    const result = await provider.execute({
      ...base,
      code: 'console.log("sum", 1 + 2, { a: 1 }); console.error("warned");',
    });
    expect(result).toEqual({ exitCode: 0, stdout: 'sum 3 {"a":1}\n', stderr: 'warned\n' });
  });

  it('exposes files read-only and drains promise jobs', async () => {
    const result = await provider.execute({
      ...base,
      code: `(async () => { files.input = 'x'; console.log(JSON.parse(files.input).n * 2); })();`,
      files: { input: '{"n":21}' },
    });
    expect(result.stdout).toBe('42\n');
    expect(result.exitCode).toBe(0);
  });

  it('reports thrown errors as exit code 1', async () => {
    const result = await provider.execute({ ...base, code: 'throw new TypeError("bad")' });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('TypeError: bad');
  });

  it('has no network, filesystem or timer globals', async () => {
    const result = await provider.execute({
      ...base,
      code: 'console.log([typeof fetch, typeof require, typeof setTimeout, typeof process, typeof pm].join(","))',
    });
    expect(result.stdout).toBe('undefined,undefined,undefined,undefined,undefined\n');
  });

  it('stops an infinite loop at the timeout', async () => {
    const result = await provider.execute({ ...base, timeoutMs: 50, code: 'while (true) {}' });
    expect(result.exitCode).toBe(SANDBOX_TIMEOUT_EXIT_CODE);
    expect(result.stderr).toContain('timed out');
  });

  it('bounds output', async () => {
    const result = await provider.execute({
      ...base,
      maxOutputBytes: 16,
      code: 'for (let i = 0; i < 100; i++) console.log("0123456789")',
    });
    expect(result.stdout.startsWith('0123456789\n01234')).toBe(true);
    expect(result.stdout).toContain('[output truncated]');
  });

  it('refuses network access and other languages', async () => {
    await expect(provider.execute({ ...base, network: 'restricted', code: '1' })).rejects.toThrow(
      /no network/
    );
    await expect(provider.execute({ ...base, language: 'python', code: '1' })).rejects.toThrow(
      /JavaScript only/
    );
  });

  it('honours an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(provider.execute({ ...base, code: '1' }, controller.signal)).rejects.toThrow();
  });
});

describe('sandbox tool source adapter (#1042)', () => {
  it('resolves a sandbox source into one read-class run_code tool', async () => {
    const resolver = createAgentToolResolver([
      createSandboxToolSourceAdapter(createDefaultSandboxRegistry()),
    ]);
    const [tool] = await resolver.resolve([{ kind: 'sandbox', sandboxId: QUICKJS_SANDBOX_ID }]);
    expect(tool?.definition.name).toBe('run_code_quickjs');
    expect(tool?.permissionClass).toBe('read');
    const output = await tool!.execute(
      { code: 'console.log(6 * 7)' },
      { signal: new AbortController().signal }
    );
    expect(output).toEqual([{ type: 'json', value: { exitCode: 0, stdout: '42\n', stderr: '' } }]);
  });

  it('refuses an unknown sandbox at preflight', () => {
    const resolver = createAgentToolResolver([
      createSandboxToolSourceAdapter(createDefaultSandboxRegistry()),
    ]);
    expect(() => resolver.assertSupported([{ kind: 'sandbox', sandboxId: 'docker' }])).toThrow(
      /unknown sandbox provider: docker/
    );
  });

  it('defaults providers without a declared permission to process (approval required)', async () => {
    const adapter = createSandboxToolSourceAdapter(
      new SandboxRegistry([
        { id: 'custom', execute: async () => ({ exitCode: 0, stdout: '', stderr: '' }) },
      ])
    );
    const [tool] = await adapter.resolve({ kind: 'sandbox', sandboxId: 'custom' });
    expect(tool?.permissionClass).toBe('process');
  });

  it('rejects malformed arguments before reaching the provider', async () => {
    const adapter = createSandboxToolSourceAdapter(createDefaultSandboxRegistry());
    const [tool] = await adapter.resolve({ kind: 'sandbox', sandboxId: QUICKJS_SANDBOX_ID });
    const signal = new AbortController().signal;
    await expect(tool!.execute({}, { signal })).rejects.toThrow(/code string/);
    await expect(tool!.execute({ code: '1', files: { a: 1 } }, { signal })).rejects.toThrow(
      /map names to strings/
    );
  });

  it('keeps tool names inside the provider name rules', () => {
    expect(sandboxToolName('a.b:c')).toBe('run_code_a_b_c');
    expect(sandboxToolName('x'.repeat(100))).toHaveLength(64);
  });
});
