import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  evaluateArchitecture,
  type ArchitectureFile,
  type ArchitecturePolicy,
} from '../scripts/architecture-policy.mts';
import {
  inspectSource,
  isArchitectureSourcePath,
  scanArchitectureFiles,
} from '../scripts/architecture-scanner.mts';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const policy: ArchitecturePolicy = {
  zones: [
    { name: 'shared', root: 'shared/' },
    { name: 'renderer', root: 'src/' },
    { name: 'worker', root: 'worker/' },
  ],
  forbiddenDependencies: [
    { from: 'shared', to: 'renderer' },
    { from: 'worker', to: 'renderer' },
  ],
  maxNewProductionFileLines: 800,
  grandfatheredFileLines: {
    'src/legacy.ts': 1_000,
  },
  allowedDependencies: [],
};

function file(
  path: string,
  imports: ArchitectureFile['imports'] = [],
  lineCount = 10
): ArchitectureFile {
  return { path, imports, lineCount };
}

describe('evaluateArchitecture', () => {
  it('rejects a forbidden dependency between architecture zones', () => {
    const violations = evaluateArchitecture(
      [
        file('shared/protocol/http.ts', [
          { specifier: '@/types', resolvedPath: 'src/types/index.ts', typeOnly: true },
        ]),
        file('src/types/index.ts'),
      ],
      policy
    );

    expect(violations).toEqual([
      expect.objectContaining({
        rule: 'forbidden-dependency',
        file: 'shared/protocol/http.ts',
        dependency: 'src/types/index.ts',
      }),
    ]);
  });

  it('permits only explicitly allowlisted legacy dependency edges', () => {
    const violations = evaluateArchitecture(
      [
        file('shared/legacy.ts', [
          { specifier: '@/types', resolvedPath: 'src/types/index.ts', typeOnly: true },
        ]),
      ],
      {
        ...policy,
        allowedDependencies: [{ fromFile: 'shared/legacy.ts', toFile: 'src/types/index.ts' }],
      }
    );

    expect(violations).toEqual([]);
  });

  it('detects runtime cycles but ignores cycles made entirely from type-only imports', () => {
    const runtimeCycle = evaluateArchitecture(
      [
        file('src/a.ts', [{ specifier: './b', resolvedPath: 'src/b.ts', typeOnly: false }]),
        file('src/b.ts', [{ specifier: './a', resolvedPath: 'src/a.ts', typeOnly: false }]),
      ],
      policy
    );
    const typeCycle = evaluateArchitecture(
      [
        file('src/a.ts', [{ specifier: './b', resolvedPath: 'src/b.ts', typeOnly: true }]),
        file('src/b.ts', [{ specifier: './a', resolvedPath: 'src/a.ts', typeOnly: true }]),
      ],
      policy
    );

    expect(runtimeCycle).toEqual([
      expect.objectContaining({ rule: 'runtime-cycle', cycle: ['src/a.ts', 'src/b.ts'] }),
    ]);
    expect(typeCycle).toEqual([]);
  });

  it('detects a runtime self-cycle and ignores unresolved external dependencies', () => {
    const violations = evaluateArchitecture(
      [
        file('src/self.ts', [
          { specifier: './self', resolvedPath: 'src/self.ts', typeOnly: false },
          { specifier: 'react', typeOnly: false },
        ]),
      ],
      policy
    );

    expect(violations).toEqual([
      expect.objectContaining({ rule: 'runtime-cycle', cycle: ['src/self.ts'] }),
    ]);
  });

  it('reports strongly connected runtime components once in deterministic order', () => {
    const violations = evaluateArchitecture(
      [
        file('src/c.ts', [{ specifier: './a', resolvedPath: 'src/a.ts', typeOnly: false }]),
        file('src/a.ts', [{ specifier: './b', resolvedPath: 'src/b.ts', typeOnly: false }]),
        file('src/b.ts', [{ specifier: './c', resolvedPath: 'src/c.ts', typeOnly: false }]),
      ],
      policy
    );

    expect(violations).toEqual([
      expect.objectContaining({
        rule: 'runtime-cycle',
        file: 'src/a.ts',
        cycle: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      }),
    ]);
  });

  it('ignores dependencies whose source or destination is outside a configured zone', () => {
    const violations = evaluateArchitecture(
      [
        file('outside/tool.ts', [
          { specifier: '@/entry', resolvedPath: 'src/entry.ts', typeOnly: false },
        ]),
        file('src/entry.ts', [
          { specifier: '../outside/other', resolvedPath: 'outside/other.ts', typeOnly: false },
        ]),
        file('outside/other.ts'),
      ],
      { ...policy, allowedDependencies: undefined }
    );

    expect(violations).toEqual([]);
  });

  it('ratchets grandfathered files and rejects oversized new production files', () => {
    const violations = evaluateArchitecture(
      [file('src/legacy.ts', [], 1_001), file('src/new-module.ts', [], 801)],
      policy
    );

    expect(violations).toEqual([
      expect.objectContaining({ rule: 'file-size', file: 'src/legacy.ts', limit: 1_000 }),
      expect.objectContaining({ rule: 'file-size', file: 'src/new-module.ts', limit: 800 }),
    ]);
  });

  it('requires a grandfathered cap to decrease when its file shrinks', () => {
    const violations = evaluateArchitecture([file('src/legacy.ts', [], 999)], policy);

    expect(violations).toEqual([
      expect.objectContaining({
        rule: 'stale-file-size-ratchet',
        file: 'src/legacy.ts',
        actual: 999,
        limit: 1_000,
      }),
    ]);
  });

  it('does not apply production file limits to tests or generated sources', () => {
    const violations = evaluateArchitecture(
      [
        file('src/__tests__/large.test.ts', [], 2_000),
        file('src/generated/spec.generated.ts', [], 2_000),
      ],
      policy
    );

    expect(violations).toEqual([]);
  });

  it('does not apply file limits outside TypeScript production sources', () => {
    const violations = evaluateArchitecture(
      [
        file('src/readme.md', [], 2_000),
        file('src/example.js', [], 2_000),
        file('src/coverage/output.ts', [], 2_000),
        file('src/dist/output.ts', [], 2_000),
        file('src/spec-types.ts', [], 2_000),
      ],
      policy
    );

    expect(violations).toEqual([]);
  });
});

describe('inspectSource', () => {
  it('distinguishes type-only imports and resolves aliases through the caller', () => {
    const source = [
      "import type { Request } from '@/types';",
      "import { execute, type Result } from '@shared/protocol';",
      "export { type Config } from './config';",
      'execute();',
    ].join('\n');

    const inspected = inspectSource('src/example.ts', source, (specifier) =>
      specifier === '@/types'
        ? 'src/types/index.ts'
        : specifier === '@shared/protocol'
          ? 'shared/protocol/index.ts'
          : specifier === './config'
            ? 'src/config.ts'
            : undefined
    );

    expect(inspected).toEqual({
      path: 'src/example.ts',
      lineCount: 4,
      imports: [
        { specifier: '@/types', resolvedPath: 'src/types/index.ts', typeOnly: true },
        {
          specifier: '@shared/protocol',
          resolvedPath: 'shared/protocol/index.ts',
          typeOnly: false,
        },
        { specifier: './config', resolvedPath: 'src/config.ts', typeOnly: true },
      ],
    });
  });

  it('finds runtime re-exports, dynamic imports, and require calls', () => {
    const inspected = inspectSource(
      'src/entry.ts',
      [
        "export * from './all';",
        "const lazy = import('./lazy');",
        "const legacy = require('./legacy');",
        'const variable = import(lazyPath);',
        'void lazy;',
        'void legacy;',
        'void variable;',
      ].join('\n'),
      (specifier) => `src/${specifier.slice(2)}.ts`
    );

    expect(inspected.imports).toEqual([
      { specifier: './all', resolvedPath: 'src/all.ts', typeOnly: false },
      { specifier: './lazy', resolvedPath: 'src/lazy.ts', typeOnly: false },
      { specifier: './legacy', resolvedPath: 'src/legacy.ts', typeOnly: false },
    ]);
  });

  it('handles declarations without sources and mixed type/value specifiers', () => {
    const inspected = inspectSource(
      'src/mixed.ts',
      [
        "import { value, type ValueType } from './dependency';",
        "export type { TypeOnly } from './types';",
        'export const local = value;',
        'export type LocalType = ValueType;',
      ].join('\n'),
      (specifier) => `src/${specifier.slice(2)}.ts`
    );

    expect(inspected.imports).toEqual([
      {
        specifier: './dependency',
        resolvedPath: 'src/dependency.ts',
        typeOnly: false,
      },
      { specifier: './types', resolvedPath: 'src/types.ts', typeOnly: true },
    ]);
  });

  it('limits the dependency graph to maintained production sources', () => {
    expect(isArchitectureSourcePath('src/features/http/client.ts')).toBe(true);
    expect(isArchitectureSourcePath('src/features/http/__tests__/client.test.ts')).toBe(false);
    expect(isArchitectureSourcePath('src/features/http/client.spec.tsx')).toBe(false);
    expect(isArchitectureSourcePath('src/generated/spec.generated.ts')).toBe(false);
    expect(isArchitectureSourcePath('src/generated/client.ts')).toBe(false);
    expect(isArchitectureSourcePath('src/client.generated.mts')).toBe(false);
  });

  it('scans configured zones and resolves relative, alias, extension, and index imports', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'restura-architecture-'));
    temporaryDirectories.push(root);
    const write = (relativePath: string, source: string): void => {
      const destination = path.join(root, relativePath);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, source);
    };

    write(
      'src/entry.tsx',
      [
        "import { rendererValue } from './renderer-value';",
        "import { nestedValue } from './nested';",
        "import type { SharedValue } from '@shared/value';",
        "import { aliasedValue } from '@/aliased';",
        'export const view = <div>{rendererValue + nestedValue + aliasedValue}</div>;',
        'export type ViewValue = SharedValue;',
      ].join('\n')
    );
    write('src/renderer-value.ts', 'export const rendererValue = 1;');
    write('src/nested/index.ts', 'export const nestedValue = 2;');
    write('src/aliased.ts', 'export const aliasedValue = 3;');
    write('src/with-extension.mts', 'export const extensionValue = 4;');
    write('src/component.tsx', 'export const componentValue = 5;');
    write('src/node-next.ts', 'export const nodeNextValue = 6;');
    write('src/node-next-module.mts', 'export const nodeNextModuleValue = 7;');
    write('src/node-next-common.cts', 'export const nodeNextCommonValue = 8;');
    write('shared/value.ts', 'export interface SharedValue { value: string }');
    write('src/entry.test.ts', "import './entry';");
    write('src/generated/client.ts', "import '../entry';");
    fs.appendFileSync(
      path.join(root, 'src/entry.tsx'),
      [
        "\nimport './with-extension.mts';",
        "import './component';",
        "import './node-next.js';",
        "import './node-next-module.mjs';",
        "import './node-next-common.cjs';",
        "import './missing';\n",
      ].join('\n')
    );

    const scanned = scanArchitectureFiles(root, {
      ...policy,
      zones: [
        { name: 'shared', root: 'shared/' },
        { name: 'renderer', root: 'src/' },
        { name: 'missing', root: 'missing/' },
      ],
    });
    const entry = scanned.find((source) => source.path === 'src/entry.tsx');

    expect(scanned.map((source) => source.path)).toEqual([
      'shared/value.ts',
      'src/aliased.ts',
      'src/component.tsx',
      'src/entry.tsx',
      'src/nested/index.ts',
      'src/node-next-common.cts',
      'src/node-next-module.mts',
      'src/node-next.ts',
      'src/renderer-value.ts',
      'src/with-extension.mts',
    ]);
    expect(entry?.imports).toEqual([
      {
        specifier: './renderer-value',
        resolvedPath: 'src/renderer-value.ts',
        typeOnly: false,
      },
      { specifier: './nested', resolvedPath: 'src/nested/index.ts', typeOnly: false },
      { specifier: '@shared/value', resolvedPath: 'shared/value.ts', typeOnly: true },
      { specifier: '@/aliased', resolvedPath: 'src/aliased.ts', typeOnly: false },
      {
        specifier: './with-extension.mts',
        resolvedPath: 'src/with-extension.mts',
        typeOnly: false,
      },
      { specifier: './component', resolvedPath: 'src/component.tsx', typeOnly: false },
      { specifier: './node-next.js', resolvedPath: 'src/node-next.ts', typeOnly: false },
      {
        specifier: './node-next-module.mjs',
        resolvedPath: 'src/node-next-module.mts',
        typeOnly: false,
      },
      {
        specifier: './node-next-common.cjs',
        resolvedPath: 'src/node-next-common.cts',
        typeOnly: false,
      },
      { specifier: './missing', resolvedPath: undefined, typeOnly: false },
    ]);
  });
});
