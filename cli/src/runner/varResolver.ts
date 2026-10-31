import { resolveVariableText } from '@shared/variables/resolver';

/**
 * Replace `{{KEY}}` placeholders against the provided variable map, then
 * expand any `{{$randomUuid}}` / `{{$timestamp}}` / etc. dynamic helpers.
 * Unknown user vars are left in place so the upstream sees them and a human
 * notices the gap. Unknown dynamic helpers (`{{$nopeNotReal}}`) are likewise
 * preserved.
 *
 * Single pass (shared core): a substituted value is not re-expanded, so a
 * script- or response-set value cannot pull in another variable. The dynamic
 * stage does run over the result, so a value like
 *   USER_NAME: "{{$randomFirstName}}"
 * still works.
 *
 * CLI policy lives here: handles and unavailable private names refuse the
 * request rather than sending it with a literal token.
 */
export function resolveVarsDeep(
  text: string,
  vars: Record<string, string>,
  unavailablePrivateNames: ReadonlySet<string> = new Set()
): string {
  if (typeof text !== 'string') return text;
  return resolveVariableText(text, [vars], {
    onToken: (name, found) => {
      if (name.startsWith('handle:')) {
        throw new Error(
          'SecretRef handles are unavailable in the CLI; provide the value with --env.'
        );
      }
      if (!found && unavailablePrivateNames.has(name)) {
        throw new Error(
          `Private variable "${name}" is unavailable in the CLI; provide it with --env.`
        );
      }
    },
  });
}
