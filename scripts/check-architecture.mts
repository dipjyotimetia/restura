import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { architecturePolicy } from './architecture.config.mts';
import { evaluateArchitecture } from './architecture-policy.mts';
import { scanArchitectureFiles } from './architecture-scanner.mts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const violations = evaluateArchitecture(
  scanArchitectureFiles(root, architecturePolicy),
  architecturePolicy
);

if (violations.length > 0) {
  console.error(`Architecture check failed with ${violations.length} violation(s):`);
  for (const violation of violations) console.error(`- [${violation.rule}] ${violation.message}`);
  process.exitCode = 1;
} else {
  console.log('Architecture policy is satisfied.');
}
