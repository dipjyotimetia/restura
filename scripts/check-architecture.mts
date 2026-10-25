import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { architecturePolicy } from './architecture.config.mts';
import { evaluateArchitectureReport } from './architecture-policy.mts';
import { scanArchitectureFiles } from './architecture-scanner.mts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { violations, warnings } = evaluateArchitectureReport(
  scanArchitectureFiles(root, architecturePolicy),
  architecturePolicy
);

if (warnings.length > 0) {
  console.warn(`Architecture caps looser than the code (${warnings.length}, not failing):`);
  for (const warning of warnings) console.warn(`- [${warning.rule}] ${warning.message}`);
  console.warn('Run `npm run architecture:tighten` (ideally in its own PR) to lower them.');
}

if (violations.length > 0) {
  console.error(`Architecture check failed with ${violations.length} violation(s):`);
  for (const violation of violations) console.error(`- [${violation.rule}] ${violation.message}`);
  process.exitCode = 1;
} else {
  console.log('Architecture policy is satisfied.');
}
