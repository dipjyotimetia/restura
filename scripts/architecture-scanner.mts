import fs from 'node:fs';
import path from 'node:path';
import { parse } from '@babel/parser';
import type {
  ArchitectureFile,
  ArchitectureImport,
  ArchitecturePolicy,
} from './architecture-policy.mts';

type ImportResolver = (specifier: string) => string | undefined;
type AstRecord = Record<string, unknown> & { type?: string };

function isRecord(value: unknown): value is AstRecord {
  return typeof value === 'object' && value !== null;
}

function stringLiteralValue(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  return value.type === 'StringLiteral' && typeof value.value === 'string'
    ? value.value
    : undefined;
}

function declarationIsTypeOnly(node: AstRecord): boolean {
  if (node.importKind === 'type' || node.exportKind === 'type') return true;
  const specifiers = Array.isArray(node.specifiers) ? node.specifiers : [];
  return (
    specifiers.length > 0 &&
    specifiers.every(
      (specifier) =>
        isRecord(specifier) && (specifier.importKind === 'type' || specifier.exportKind === 'type')
    )
  );
}

function addImport(
  imports: ArchitectureImport[],
  specifier: string,
  typeOnly: boolean,
  resolve: ImportResolver
): void {
  imports.push({ specifier, resolvedPath: resolve(specifier), typeOnly });
}

export function inspectSource(
  filePath: string,
  sourceText: string,
  resolve: ImportResolver
): ArchitectureFile {
  const ast = parse(sourceText, {
    sourceType: 'unambiguous',
    createImportExpressions: true,
    plugins: ['typescript', 'jsx', 'importAttributes'],
  });
  const imports: ArchitectureImport[] = [];

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (!isRecord(value)) return;

    if (
      value.type === 'ImportDeclaration' ||
      value.type === 'ExportNamedDeclaration' ||
      value.type === 'ExportAllDeclaration'
    ) {
      const specifier = stringLiteralValue(value.source);
      if (specifier) addImport(imports, specifier, declarationIsTypeOnly(value), resolve);
    } else if (value.type === 'ImportExpression') {
      const specifier = stringLiteralValue(value.source);
      if (specifier) addImport(imports, specifier, false, resolve);
    } else if (value.type === 'TSImportEqualsDeclaration') {
      const moduleReference = value.moduleReference;
      const specifier =
        isRecord(moduleReference) && moduleReference.type === 'TSExternalModuleReference'
          ? stringLiteralValue(moduleReference.expression)
          : undefined;
      if (specifier) addImport(imports, specifier, false, resolve);
    } else if (value.type === 'CallExpression') {
      const callee = value.callee;
      const args = Array.isArray(value.arguments) ? value.arguments : [];
      const specifier = stringLiteralValue(args[0]);
      if (
        specifier &&
        isRecord(callee) &&
        ((callee.type === 'Identifier' && callee.name === 'require') || callee.type === 'Import')
      ) {
        addImport(imports, specifier, false, resolve);
      }
    }

    for (const [key, child] of Object.entries(value)) {
      if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue;
      visit(child);
    }
  };

  visit(ast.program);
  const newlineCount = sourceText.match(/\n/g)?.length ?? 0;
  const lineCount = newlineCount + (sourceText.length > 0 && !sourceText.endsWith('\n') ? 1 : 0);
  return { path: filePath, imports, lineCount };
}

function normalizeRelative(root: string, filePath: string): string | undefined {
  const relative = path.relative(root, filePath).split(path.sep).join('/');
  return relative.startsWith('../') ? undefined : relative;
}

function resolveInternalImport(
  root: string,
  fromFile: string,
  specifier: string
): string | undefined {
  let candidate: string | undefined;
  if (specifier.startsWith('@/')) candidate = path.join(root, 'src', specifier.slice(2));
  else if (specifier.startsWith('@shared/')) {
    candidate = path.join(root, 'shared', specifier.slice('@shared/'.length));
  } else if (specifier.startsWith('.')) candidate = path.resolve(path.dirname(fromFile), specifier);
  if (!candidate) return undefined;

  const nodeNextSourceCandidates: string[] = [];
  const extension = path.extname(candidate);
  if (extension === '.js') {
    const sourceBase = candidate.slice(0, -extension.length);
    nodeNextSourceCandidates.push(`${sourceBase}.ts`, `${sourceBase}.tsx`);
  } else if (extension === '.mjs') {
    nodeNextSourceCandidates.push(`${candidate.slice(0, -extension.length)}.mts`);
  } else if (extension === '.cjs') {
    nodeNextSourceCandidates.push(`${candidate.slice(0, -extension.length)}.cts`);
  }

  for (const possible of [
    candidate,
    ...nodeNextSourceCandidates,
    `${candidate}.ts`,
    `${candidate}.tsx`,
    `${candidate}.mts`,
    `${candidate}.cts`,
    path.join(candidate, 'index.ts'),
    path.join(candidate, 'index.tsx'),
  ]) {
    if (fs.existsSync(possible) && fs.statSync(possible).isFile()) {
      return normalizeRelative(root, possible);
    }
  }
  return undefined;
}

export function isArchitectureSourcePath(filePath: string): boolean {
  const normalized = filePath.split(path.sep).join('/');
  const fileName = path.posix.basename(normalized);
  return (
    !normalized.split('/').includes('__tests__') &&
    !/\.(?:test|spec)\.(?:ts|tsx|mts|cts)$/.test(fileName) &&
    !/(?:^|\/)generated(?:\/|$)/.test(normalized) &&
    !/\.generated\.(?:ts|tsx|mts|cts)$/.test(fileName)
  );
}

function collectSourceFiles(directory: string, output: string[]): void {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'out', 'coverage'].includes(entry.name)) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) collectSourceFiles(entryPath, output);
    else if (/\.(?:ts|tsx|mts|cts)$/.test(entry.name) && isArchitectureSourcePath(entryPath)) {
      output.push(entryPath);
    }
  }
}

export function scanArchitectureFiles(
  root: string,
  policy: ArchitecturePolicy
): ArchitectureFile[] {
  const sourcePaths: string[] = [];
  for (const zone of policy.zones) collectSourceFiles(path.join(root, zone.root), sourcePaths);

  return [...new Set(sourcePaths.map((filePath) => path.resolve(filePath)))]
    .sort()
    .map((absolutePath) => {
      const relativePath = normalizeRelative(root, absolutePath);
      if (!relativePath) throw new Error(`Source file is outside repository root: ${absolutePath}`);
      return inspectSource(relativePath, fs.readFileSync(absolutePath, 'utf8'), (specifier) =>
        resolveInternalImport(root, absolutePath, specifier)
      );
    });
}
