import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Reporter, RunResult } from '../../reporters/types';
import { runCollection } from '../runner';

/**
 * Variable precedence through the CLI runner, observed from inside the sandbox:
 * every request records the URL it resolved to as an assertion name. The port is
 * closed on purpose; the test script still runs after the failed send. The
 * request URL is `http://127.0.0.1:1/<path template>`, so a variable lands in the path.
 */

class NoopReporter implements Reporter {
  onEnd(_r: RunResult): void {}
}

const ORIGIN = 'http://127.0.0.1:1/';

function request(name: string, path: string, pre?: string): object {
  const scripts: Array<{ type: string; code: string }> = [
    { type: 'tests', code: "pm.test('SEEN ' + pm.request.url.toString(), () => {});" },
  ];
  if (pre) scripts.push({ type: 'before-request', code: pre });
  return {
    info: { type: 'http', name, seq: 1 },
    http: { method: 'GET', url: `${ORIGIN}${path}` },
    runtime: { scripts },
  };
}

function folder(name: string, variables: Array<{ name: string; value: string }>, items: object[]) {
  return { info: { name, seq: 1 }, request: { variables }, items };
}

/** A bundled OpenCollection (JSON is valid YAML). */
function writeCollection(
  items: object[],
  collectionVariables: Array<{ name: string; value: string }> = []
): string {
  const dir = mkdtempSync(join(tmpdir(), 'restura-scope-'));
  const file = join(dir, 'collection.yaml');
  writeFileSync(
    file,
    JSON.stringify({
      opencollection: '1.0.0',
      info: { name: 'Scope', version: '0.1.0' },
      bundled: true,
      ...(collectionVariables.length > 0
        ? { config: { environments: [{ name: 'default', variables: collectionVariables }] } }
        : {}),
      items,
    })
  );
  return file;
}

async function run(
  file: string,
  iterations?: Array<Record<string, string>>,
  overrideVars?: Record<string, string>
): Promise<string[]> {
  const result = await runCollection(
    file,
    {
      envVars: {},
      ...(overrideVars ? { overrideVars } : {}),
      bail: false,
      timeoutMs: 500,
      allowLocalhost: true,
      ...(iterations ? { iterations } : {}),
    },
    new NoopReporter()
  );
  return result.requests.map(
    (r) => r.assertions?.find((a) => a.name.startsWith('SEEN '))?.name.slice(5) ?? '<none>'
  );
}

describe('runCollection — variable precedence', () => {
  // `start` records the value of `key` as the request started, before its own
  // pre-request script writes anything.
  const peek = (key: string) => `pm.environment.set('start', String(pm.variables.get('${key}')));`;

  it('a script write in this iteration beats the data row', async () => {
    const file = writeCollection([
      request('a', '{{start}}/{{x}}', `${peek('x')} pm.environment.set('x', 'script');`),
      request('b', '{{x}}'),
    ]);
    expect(await run(file, [{ x: 'row' }])).toEqual([`${ORIGIN}row/script`, `${ORIGIN}script`]);
  });

  it('a write from an earlier iteration sits below the next data row', async () => {
    const file = writeCollection([
      request('a', '{{start}}/{{x}}', `${peek('x')} pm.environment.set('x', 'script');`),
    ]);
    expect(await run(file, [{ x: 'row1' }, { x: 'row2' }])).toEqual([
      `${ORIGIN}row1/script`,
      `${ORIGIN}row2/script`,
    ]);
  });

  it('a write from an earlier iteration carries when the next row lacks the key', async () => {
    const file = writeCollection([
      request(
        'a',
        '{{start}}/{{token}}',
        `${peek('token')} pm.environment.set('token', 'T' + pm.iterationData.get('id'));`
      ),
    ]);
    expect(await run(file, [{ id: '1' }, { id: '2' }])).toEqual([
      `${ORIGIN}undefined/T1`,
      `${ORIGIN}T1/T2`,
    ]);
  });

  it('a write from an earlier iteration sits ABOVE a folder variable (the app keeps it below)', async () => {
    const file = writeCollection([
      folder(
        'F',
        [{ name: 'host', value: 'folder' }],
        [
          request(
            'a',
            '{{start}}',
            `${peek('host')} if (pm.iterationData.get('id') === '1') pm.environment.set('host', 'script');`
          ),
        ]
      ),
    ]);
    expect(await run(file, [{ id: '1' }, { id: '2' }])).toEqual([
      `${ORIGIN}folder`,
      `${ORIGIN}script`,
    ]);
  });

  it('--env-var values sit above folder variables and below the data row', async () => {
    const file = writeCollection([
      folder('F', [{ name: 'host', value: 'folder' }], [request('a', '{{host}}/{{x}}')]),
    ]);
    expect(await run(file, [{ x: 'row' }], { host: 'override', x: 'override' })).toEqual([
      `${ORIGIN}override/row`,
    ]);
  });

  it('folder variables sit above collection variables, inner above outer', async () => {
    const file = writeCollection(
      [
        folder(
          'Outer',
          [
            { name: 'host', value: 'outer' },
            { name: 'tier', value: 'outer' },
          ],
          [folder('Inner', [{ name: 'host', value: 'inner' }], [request('a', '{{host}}/{{tier}}')])]
        ),
      ],
      [{ name: 'host', value: 'collection' }]
    );
    expect(await run(file)).toEqual([`${ORIGIN}inner/outer`]);
  });

  // The app substitutes a `pm.collectionVariables` write into later requests;
  // the CLI keeps it in `pm.collectionVariables` only (probed on this branch).
  it.todo(
    'DIVERGENCE: a pm.collectionVariables write is visible to {{var}} substitution of later requests (app: yes, CLI: no)'
  );

  it('CURRENT: a pm.collectionVariables write is not substituted into later requests', async () => {
    const file = writeCollection([
      request('a', 'one', "pm.collectionVariables.set('token', 'abc');"),
      request('b', '{{token}}'),
    ]);
    expect((await run(file))[1]).toBe(`${ORIGIN}{{token}}`);
  });
});
