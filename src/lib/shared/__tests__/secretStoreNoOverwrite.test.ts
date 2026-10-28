import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * #1226 ratchet: desktop handle conversion lets an inheriting request SHARE its
 * ancestor's keychain handle id. That is only safe while no renderer writer of
 * collection auth secrets overwrites a handle in place, i.e. never passes an
 * `id` to `secrets.store(...)` (main's `storeSecretHandle` treats an `id` as
 * "update this record"). If this fails, editing one request's secret would
 * silently rewrite its ancestor's (and every sharer's) credential.
 */
const WRITERS = [
  'src/features/auth/components/SecretInput.tsx',
  'src/lib/shared/secretRef-migrations.ts',
];

/** Argument text of every `store(` call (balanced parens). */
function storeCallArgs(source: string): string[] {
  const out: string[] = [];
  const re = /\bstore\(/g;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < source.length && depth > 0; i++) {
      if (source[i] === '(') depth++;
      else if (source[i] === ')') depth--;
    }
    out.push(source.slice(start, i - 1).trim());
  }
  return out;
}

/** The object literal assigned to `const <name> = { ... }`, or undefined. */
function constLiteral(source: string, name: string): string | undefined {
  const at = source.search(new RegExp(`const\\s+${name}\\s*=\\s*\\{`));
  if (at === -1) return undefined;
  let i = source.indexOf('{', at);
  const start = i;
  let depth = 0;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) break;
  }
  return source.slice(start, i + 1);
}

const passesId = (literal: string) => /[{,\s]id\s*[:,}]|\.\.\.\s*\{\s*id\b/.test(literal);

describe('collection-auth secret writers never overwrite a handle in place (#1226)', () => {
  for (const file of WRITERS) {
    it(`${file}: no secrets.store call passes an id`, () => {
      const source = readFileSync(resolve(process.cwd(), file), 'utf8');
      const calls = storeCallArgs(source);
      expect(calls.length).toBeGreaterThan(0);
      for (const arg of calls) {
        if (arg.startsWith('{')) {
          expect(passesId(arg), `store(${arg})`).toBe(false);
          continue;
        }
        const literal = constLiteral(source, arg);
        if (literal) {
          expect(passesId(literal), `store(${arg}) = ${literal}`).toBe(false);
          continue;
        }
        // Only a pure pass-through wrapper may forward an opaque argument; its
        // callers in the same file are themselves scanned above.
        expect(source, `unverifiable store(${arg})`).toMatch(
          new RegExp(`\\(${arg}\\)\\s*=>\\s*api\\.secrets\\.store\\(${arg}\\)`)
        );
      }
    });
  }

  it('the scan detects an id (self-test)', () => {
    expect(passesId("{ id: existing, value: 'x' }")).toBe(true);
    expect(passesId('{ value, label, id }')).toBe(true);
    expect(passesId('{ ...(x ? { id: x } : {}), value }')).toBe(true);
    expect(passesId('{ value: plaintext, label }')).toBe(false);
  });
});
