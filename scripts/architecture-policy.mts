export interface ArchitectureImport {
  specifier: string;
  resolvedPath?: string;
  typeOnly: boolean;
}

export interface ArchitectureFile {
  path: string;
  imports: ArchitectureImport[];
  lineCount: number;
  /** Matches per `sourcePatternRatchets` name (production sources only). */
  patternCounts?: Record<string, number>;
}

/**
 * A repo-wide count of a source pattern that may only go down — e.g. ad-hoc
 * pixel font sizes outside the type scale. Exact, like the file-size caps: a
 * decrease must lower `max` in the same change.
 */
export interface SourcePatternRatchet {
  name: string;
  /** Path prefix the count covers, e.g. 'src/'. */
  pathPrefix: string;
  /** File extension the count covers, e.g. '.tsx'. */
  extension: string;
  /** Regular-expression source, matched globally. */
  pattern: string;
  max: number;
}

export interface ArchitectureZone {
  name: string;
  root: string;
}

export interface ForbiddenDependency {
  from: string;
  to: string;
}

export interface ArchitecturePolicy {
  zones: ArchitectureZone[];
  forbiddenDependencies: ForbiddenDependency[];
  maxNewProductionFileLines: number;
  grandfatheredFileLines: Record<string, number>;
  allowedDependencies?: Array<{ fromFile: string; toFile: string }>;
  sourcePatternRatchets?: SourcePatternRatchet[];
}

export type ArchitectureViolation =
  | {
      rule: 'pattern-ratchet' | 'stale-pattern-ratchet';
      file: string;
      actual: number;
      limit: number;
      message: string;
    }
  | {
      rule: 'forbidden-dependency';
      file: string;
      dependency: string;
      message: string;
    }
  | {
      rule: 'runtime-cycle';
      file: string;
      cycle: string[];
      message: string;
    }
  | {
      rule: 'file-size';
      file: string;
      actual: number;
      limit: number;
      message: string;
    }
  | {
      rule: 'stale-file-size-ratchet';
      file: string;
      actual: number;
      limit: number;
      message: string;
    };

function zoneFor(path: string, policy: ArchitecturePolicy): string | undefined {
  return policy.zones.find((zone) => path.startsWith(zone.root))?.name;
}

/** Count each applicable ratchet pattern in one source file. */
export function countSourcePatterns(
  path: string,
  sourceText: string,
  policy: ArchitecturePolicy
): Record<string, number> | undefined {
  const ratchets = (policy.sourcePatternRatchets ?? []).filter(
    (r) => path.startsWith(r.pathPrefix) && path.endsWith(r.extension) && isProductionSource(path)
  );
  if (ratchets.length === 0) return undefined;
  return Object.fromEntries(
    ratchets.map((r) => [r.name, sourceText.match(new RegExp(r.pattern, 'g'))?.length ?? 0])
  );
}

function isProductionSource(path: string): boolean {
  return (
    /\.(?:ts|tsx|mts|cts)$/.test(path) &&
    !/(?:^|\/)__tests__(?:\/|$)/.test(path) &&
    !/\.(?:test|spec)\.(?:ts|tsx|mts|cts)$/.test(path) &&
    !/(?:^|\/)tests?(?:\/|$)/.test(path) &&
    !/(?:^|\/)(?:dist|out|coverage)(?:\/|$)/.test(path) &&
    !/(?:generated|spec-types|bundle\.generated)\.(?:ts|tsx|mts|cts)$/.test(path)
  );
}

function findRuntimeCycles(files: ArchitectureFile[]): string[][] {
  const knownFiles = new Set(files.map((file) => file.path));
  const graph = new Map<string, string[]>();

  for (const file of files) {
    graph.set(
      file.path,
      file.imports
        .filter(
          (dependency) =>
            !dependency.typeOnly &&
            dependency.resolvedPath !== undefined &&
            knownFiles.has(dependency.resolvedPath)
        )
        .map((dependency) => dependency.resolvedPath as string)
    );
  }

  let nextIndex = 0;
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycles: string[][] = [];

  const visit = (file: string): void => {
    const index = nextIndex++;
    indices.set(file, index);
    lowLinks.set(file, index);
    stack.push(file);
    onStack.add(file);

    for (const dependency of graph.get(file) ?? []) {
      if (!indices.has(dependency)) {
        visit(dependency);
        lowLinks.set(file, Math.min(lowLinks.get(file)!, lowLinks.get(dependency)!));
      } else if (onStack.has(dependency)) {
        lowLinks.set(file, Math.min(lowLinks.get(file)!, indices.get(dependency)!));
      }
    }

    if (lowLinks.get(file) !== indices.get(file)) return;

    const component: string[] = [];
    let current: string;
    do {
      current = stack.pop()!;
      onStack.delete(current);
      component.push(current);
    } while (current !== file);

    const selfCycle = component.length === 1 && (graph.get(component[0]!) ?? []).includes(file);
    if (component.length > 1 || selfCycle) cycles.push(component.sort());
  };

  for (const file of [...graph.keys()].sort()) {
    if (!indices.has(file)) visit(file);
  }

  return cycles.sort((left, right) => left.join('\0').localeCompare(right.join('\0')));
}

export function evaluateArchitecture(
  files: ArchitectureFile[],
  policy: ArchitecturePolicy
): ArchitectureViolation[] {
  const violations: ArchitectureViolation[] = [];

  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    const sourceZone = zoneFor(file.path, policy);
    for (const dependency of file.imports) {
      if (!sourceZone || !dependency.resolvedPath) continue;
      const targetZone = zoneFor(dependency.resolvedPath, policy);
      const forbidden = policy.forbiddenDependencies.some(
        (rule) => rule.from === sourceZone && rule.to === targetZone
      );
      const allowlisted = policy.allowedDependencies?.some(
        (edge) => edge.fromFile === file.path && edge.toFile === dependency.resolvedPath
      );
      if (forbidden && !allowlisted) {
        violations.push({
          rule: 'forbidden-dependency',
          file: file.path,
          dependency: dependency.resolvedPath,
          message: `${sourceZone} must not depend on ${targetZone}: ${dependency.specifier}`,
        });
      }
    }

    if (isProductionSource(file.path)) {
      const grandfatheredLimit = policy.grandfatheredFileLines[file.path];
      const limit = grandfatheredLimit ?? policy.maxNewProductionFileLines;
      if (file.lineCount > limit) {
        violations.push({
          rule: 'file-size',
          file: file.path,
          actual: file.lineCount,
          limit,
          message: `${file.path} has ${file.lineCount} lines; the architecture cap is ${limit}`,
        });
      } else if (grandfatheredLimit !== undefined && file.lineCount < grandfatheredLimit) {
        violations.push({
          rule: 'stale-file-size-ratchet',
          file: file.path,
          actual: file.lineCount,
          limit: grandfatheredLimit,
          message: `${file.path} shrank to ${file.lineCount} lines; lower its grandfathered cap from ${grandfatheredLimit}`,
        });
      }
    }
  }

  for (const ratchet of policy.sourcePatternRatchets ?? []) {
    const actual = files.reduce((sum, file) => sum + (file.patternCounts?.[ratchet.name] ?? 0), 0);
    if (actual > ratchet.max) {
      violations.push({
        rule: 'pattern-ratchet',
        file: ratchet.pathPrefix,
        actual,
        limit: ratchet.max,
        message: `${ratchet.name}: ${actual} occurrences under ${ratchet.pathPrefix}; the cap is ${ratchet.max}`,
      });
    } else if (actual < ratchet.max) {
      violations.push({
        rule: 'stale-pattern-ratchet',
        file: ratchet.pathPrefix,
        actual,
        limit: ratchet.max,
        message: `${ratchet.name} dropped to ${actual}; lower its cap from ${ratchet.max}`,
      });
    }
  }

  for (const cycle of findRuntimeCycles(files)) {
    violations.push({
      rule: 'runtime-cycle',
      file: cycle[0]!,
      cycle,
      message: `Runtime import cycle: ${cycle.join(' -> ')}`,
    });
  }

  return violations;
}
