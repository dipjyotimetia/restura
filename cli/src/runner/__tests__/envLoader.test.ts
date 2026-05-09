import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv } from '../envLoader';

describe('loadEnv', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'restura-env-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('loads JSON env file', async () => {
    const file = join(dir, 'env.json');
    await writeFile(file, JSON.stringify({ API_BASE: 'https://api.example.com', TOKEN: 'abc' }));
    const env = await loadEnv(file);
    expect(env).toEqual({ API_BASE: 'https://api.example.com', TOKEN: 'abc' });
  });

  it('loads YAML env file (.yaml)', async () => {
    const file = join(dir, 'env.yaml');
    await writeFile(file, 'API_BASE: https://api.example.com\nTOKEN: abc\n');
    const env = await loadEnv(file);
    expect(env).toEqual({ API_BASE: 'https://api.example.com', TOKEN: 'abc' });
  });

  it('loads YAML env file (.yml)', async () => {
    const file = join(dir, 'env.yml');
    await writeFile(file, 'FOO: bar\n');
    const env = await loadEnv(file);
    expect(env).toEqual({ FOO: 'bar' });
  });

  it('throws on non-object root (array)', async () => {
    const file = join(dir, 'env.json');
    await writeFile(file, JSON.stringify(['a', 'b']));
    await expect(loadEnv(file)).rejects.toThrow(/object of key/i);
  });

  it('throws on non-object root (string)', async () => {
    const file = join(dir, 'env.json');
    await writeFile(file, JSON.stringify('hello'));
    await expect(loadEnv(file)).rejects.toThrow(/object of key/i);
  });

  it('skips non-string values', async () => {
    const file = join(dir, 'env.json');
    await writeFile(
      file,
      JSON.stringify({ STRING_VAL: 'ok', NUM_VAL: 42, BOOL_VAL: true, NULL_VAL: null })
    );
    const env = await loadEnv(file);
    expect(env).toEqual({ STRING_VAL: 'ok' });
  });

  it('expands ${VAR} placeholders from process.env when option is set', async () => {
    process.env.TEST_RESTURA_TOKEN = 'secret-from-ci';
    try {
      const file = join(dir, 'env.json');
      await writeFile(file, JSON.stringify({ TOKEN: '${TEST_RESTURA_TOKEN}', PLAIN: 'literal' }));
      const env = await loadEnv(file, { expandEnvVars: true });
      expect(env).toEqual({ TOKEN: 'secret-from-ci', PLAIN: 'literal' });
    } finally {
      delete process.env.TEST_RESTURA_TOKEN;
    }
  });

  it('does NOT expand ${VAR} when option is unset (default behaviour)', async () => {
    process.env.TEST_RESTURA_TOKEN = 'secret-from-ci';
    try {
      const file = join(dir, 'env.json');
      await writeFile(file, JSON.stringify({ TOKEN: '${TEST_RESTURA_TOKEN}' }));
      const env = await loadEnv(file);
      expect(env).toEqual({ TOKEN: '${TEST_RESTURA_TOKEN}' });
    } finally {
      delete process.env.TEST_RESTURA_TOKEN;
    }
  });

  it('expands missing env vars to empty string', async () => {
    delete process.env.RESTURA_DEFINITELY_UNSET;
    const file = join(dir, 'env.json');
    await writeFile(file, JSON.stringify({ X: 'before-${RESTURA_DEFINITELY_UNSET}-after' }));
    const env = await loadEnv(file, { expandEnvVars: true });
    expect(env).toEqual({ X: 'before--after' });
  });
});
