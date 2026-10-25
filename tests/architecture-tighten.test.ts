import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ArchitecturePolicy } from '../scripts/architecture-policy.mts';
import { measure, tightenConfigSource } from '../scripts/architecture-tighten.mts';

const config = `export const architecturePolicy = {
  maxNewProductionFileLines: 800,
  grandfatheredFileLines: {
    'shared/big.ts': 1_194,
    'electron/main/handler.ts': 861, // split tracked in #123
    'electron/main/shrunk.ts': 900,
    'electron/main/gone.ts': 1007,
    'electron/main/unchanged.ts': 959,
    'electron/main/strict.ts': 670,
  },
  // Type scale: text-[Npx] may only go down.
  sourcePatternRatchets: [
    {
      name: 'arbitrary pixel font sizes (text-[Npx])',
      pathPrefix: 'src/',
      extension: '.tsx',
      pattern: String.raw\`\\btext-\\[\\d+(?:\\.\\d+)?px\\]\`,
      max: 85,
    },
    {
      name: 'sub-11px type tokens',
      pathPrefix: 'src/',
      extension: '.tsx',
      pattern: String.raw\`\\btext-sp-(?:9|10)\\b\`,
      max: 93,
    },
  ],
};
`;

describe('tightenConfigSource', () => {
  it('lowers caps to actual values, removes fitting/missing entries, keeps comments', () => {
    const { source, changes } = tightenConfigSource(config, {
      maxNewProductionFileLines: 800,
      fileLines: {
        'shared/big.ts': 1_100,
        'electron/main/handler.ts': 850,
        'electron/main/shrunk.ts': 640,
        'electron/main/gone.ts': undefined,
        'electron/main/unchanged.ts': 959,
        'electron/main/strict.ts': 600,
      },
      patternCounts: { 'arbitrary pixel font sizes (text-[Npx])': 80, 'sub-11px type tokens': 93 },
    });

    expect(source).toContain("    'shared/big.ts': 1_100,\n");
    expect(source).toContain("    'electron/main/handler.ts': 850, // split tracked in #123\n");
    expect(source).toContain("    'electron/main/unchanged.ts': 959,\n");
    // A cap already below the default is a deliberate stricter limit: tightened, not dropped.
    expect(source).toContain("    'electron/main/strict.ts': 600,\n");
    expect(source).not.toContain('shrunk.ts');
    expect(source).not.toContain('gone.ts');
    expect(source).toContain('      max: 80,\n');
    expect(source).toContain('      max: 93,\n');
    expect(source).toContain('// Type scale: text-[Npx] may only go down.');
    expect(changes).toEqual([
      'shared/big.ts: 1194 → 1100',
      'electron/main/handler.ts: 861 → 850',
      'removed electron/main/shrunk.ts (640 lines fits the 800-line default)',
      'removed electron/main/gone.ts (file no longer exists)',
      'electron/main/strict.ts: 670 → 600',
      'arbitrary pixel font sizes (text-[Npx]): 85 → 80',
    ]);
  });

  it('never raises a cap and is a no-op when the caps already match', () => {
    const { source, changes } = tightenConfigSource(config, {
      maxNewProductionFileLines: 800,
      fileLines: { 'shared/big.ts': 1_300 },
      patternCounts: { 'sub-11px type tokens': 120 },
    });
    expect(changes).toEqual([]);
    expect(source).toBe(config);
  });

  it('leaves entries it was not given measurements for untouched', () => {
    const { source } = tightenConfigSource(config, {
      maxNewProductionFileLines: 800,
      fileLines: {},
      patternCounts: {},
    });
    expect(source).toBe(config);
  });
});

describe('measure', () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0))
      fs.rmSync(directory, { recursive: true, force: true });
  });

  it('reports scanned line counts, missing files, and summed pattern counts', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'restura-tighten-'));
    directories.push(root);
    fs.mkdirSync(path.join(root, 'docs'));
    fs.writeFileSync(path.join(root, 'docs/unscanned.ts'), '');
    const policy: ArchitecturePolicy = {
      zones: [],
      forbiddenDependencies: [],
      maxNewProductionFileLines: 800,
      grandfatheredFileLines: { 'src/a.ts': 900, 'src/gone.ts': 900, 'docs/unscanned.ts': 900 },
      sourcePatternRatchets: [
        { name: 'px', pathPrefix: 'src/', extension: '.tsx', pattern: 'x', max: 9 },
      ],
    };
    const input = measure(
      root,
      [
        { path: 'src/a.ts', imports: [], lineCount: 850 },
        { path: 'src/b.tsx', imports: [], lineCount: 1, patternCounts: { px: 2 } },
        { path: 'src/c.tsx', imports: [], lineCount: 1, patternCounts: { px: 3 } },
      ],
      policy
    );
    expect(input).toEqual({
      maxNewProductionFileLines: 800,
      fileLines: { 'src/a.ts': 850, 'src/gone.ts': undefined },
      patternCounts: { px: 5 },
    });
  });
});
