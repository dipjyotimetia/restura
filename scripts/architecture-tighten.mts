// Ratchet the architecture caps in architecture.config.mts down to the code.
//
// `architecture:check` only fails when a cap is EXCEEDED; a cap that is looser
// than the code is a warning. This rewrites the config so the slack is removed:
//   - grandfatheredFileLines[path] → the file's current line count (never up);
//     entries grandfathered above maxNewProductionFileLines whose file now fits
//     under it, or whose file no longer exists, are removed. Entries already at
//     or below the default are deliberately stricter caps and are kept.
//   - sourcePatternRatchets[].max → the current repo-wide count (never up).
// Edits are targeted text replacements, so comments and layout survive.
//
// CLI: scripts/tighten-architecture.mts (npm run architecture:tighten).

import fs from 'node:fs';
import path from 'node:path';
import type { ArchitectureFile, ArchitecturePolicy } from './architecture-policy.mts';

export interface TightenInput {
  /** Current line count per grandfathered path; `undefined` = file is gone. */
  fileLines: Record<string, number | undefined>;
  /** Current repo-wide count per ratchet name. */
  patternCounts: Record<string, number>;
  maxNewProductionFileLines: number;
}

export interface TightenResult {
  source: string;
  changes: string[];
}

function formatNumber(value: number, likeOriginal: string): string {
  return likeOriginal.includes('_') && value >= 1_000
    ? String(value).replace(/\B(?=(\d{3})+(?!\d))/g, '_')
    : String(value);
}

/** Span of the `{ ... }` / `[ ... ]` literal that follows `key:`. */
function literalSpan(source: string, key: string): { start: number; end: number } | undefined {
  const keyIndex = source.search(new RegExp(String.raw`\b${key}\s*:`));
  if (keyIndex < 0) return undefined;
  const open = source.slice(keyIndex).search(/[[{]/);
  if (open < 0) return undefined;
  const start = keyIndex + open;
  let depth = 0;
  let quote: string | undefined;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    // Line comments may hold apostrophes or brackets; skip to end of line.
    if (!quote && char === '/' && source[index + 1] === '/') {
      const newline = source.indexOf('\n', index);
      if (newline < 0) return undefined;
      index = newline;
      continue;
    }
    // Brackets inside string literals (regex sources, names) do not nest.
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') quote = char;
    else if (char === '{' || char === '[') depth += 1;
    else if (char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0) return { start, end: index + 1 };
    }
  }
  return undefined;
}

export function tightenConfigSource(source: string, input: TightenInput): TightenResult {
  const changes: string[] = [];
  let output = source;

  const files = literalSpan(output, 'grandfatheredFileLines');
  if (files) {
    const block = output.slice(files.start, files.end);
    const entry = /^([ \t]*)(['"])([^'"]+)\2:\s*([\d_]+),?[ \t]*(\/\/[^\n]*)?\n/gm;
    const tightened = block.replace(
      entry,
      (line, indent: string, quote: string, file: string, raw: string, comment?: string) => {
        const cap = Number(raw.replace(/_/g, ''));
        if (!(file in input.fileLines)) return line;
        const actual = input.fileLines[file];
        if (actual === undefined) {
          changes.push(`removed ${file} (file no longer exists)`);
          return '';
        }
        // Only drop caps that were grandfathered ABOVE the default; an entry at
        // or below it is a deliberately stricter cap, and removing it would
        // loosen the limit to the default.
        if (cap > input.maxNewProductionFileLines && actual <= input.maxNewProductionFileLines) {
          changes.push(
            `removed ${file} (${actual} lines fits the ${input.maxNewProductionFileLines}-line default)`
          );
          return '';
        }
        if (actual >= cap) return line;
        changes.push(`${file}: ${cap} → ${actual}`);
        return `${indent}${quote}${file}${quote}: ${formatNumber(actual, raw)},${comment ? ` ${comment}` : ''}\n`;
      }
    );
    output = output.slice(0, files.start) + tightened + output.slice(files.end);
  }

  const ratchets = literalSpan(output, 'sourcePatternRatchets');
  if (ratchets) {
    let block = output.slice(ratchets.start, ratchets.end);
    for (const [name, actual] of Object.entries(input.patternCounts)) {
      const nameIndex = Math.max(
        block.indexOf(`name: '${name}'`),
        block.indexOf(`name: "${name}"`)
      );
      if (nameIndex < 0) continue;
      const rest = block.slice(nameIndex);
      const match = /\bmax:\s*([\d_]+)/.exec(rest);
      if (!match) continue;
      const cap = Number(match[1]!.replace(/_/g, ''));
      if (actual >= cap) continue;
      const at = nameIndex + match.index;
      block = `${block.slice(0, at)}max: ${formatNumber(actual, match[1]!)}${block.slice(at + match[0].length)}`;
      changes.push(`${name}: ${cap} → ${actual}`);
    }
    output = output.slice(0, ratchets.start) + block + output.slice(ratchets.end);
  }

  return { source: output, changes };
}

/** Measure the repo for the caps the policy declares. */
export function measure(
  root: string,
  files: ArchitectureFile[],
  policy: ArchitecturePolicy
): TightenInput {
  const scanned = new Map(files.map((file) => [file.path, file]));
  const fileLines: Record<string, number | undefined> = {};
  for (const file of Object.keys(policy.grandfatheredFileLines)) {
    const found = scanned.get(file);
    if (found) fileLines[file] = found.lineCount;
    // Outside the scanned zones but on disk: leave its cap alone.
    else if (!fs.existsSync(path.join(root, file))) fileLines[file] = undefined;
  }
  const patternCounts = Object.fromEntries(
    (policy.sourcePatternRatchets ?? []).map((ratchet) => [
      ratchet.name,
      files.reduce((sum, file) => sum + (file.patternCounts?.[ratchet.name] ?? 0), 0),
    ])
  );
  return { fileLines, patternCounts, maxNewProductionFileLines: policy.maxNewProductionFileLines };
}
