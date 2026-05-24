import { applyDynamicVariables } from '@/lib/shared/dynamicVariables';

/**
 * Replace `{{KEY}}` placeholders against the provided variable map, then
 * expand any `{{$randomUuid}}` / `{{$timestamp}}` / etc. dynamic helpers via
 * `applyDynamicVariables`. Unknown user vars are left in place (as `{{KEY}}`)
 * so the upstream sees them and a human notices the gap. Unknown dynamic
 * helpers (`{{$nopeNotReal}}`) are likewise preserved.
 *
 * Order matters: user vars resolve first so that a value like
 *   USER_NAME: "{{$randomFirstName}}"
 * still works — the substituted dynamic placeholder is then expanded.
 */
export function resolveVarsDeep(text: string, vars: Record<string, string>): string {
  if (typeof text !== 'string') return text;
  const userResolved = text.replace(
    /\{\{\s*([A-Za-z0-9_$.]+)\s*\}\}/g,
    (match, key: string) => {
      // Leave $-prefixed (dynamic) placeholders for the next stage.
      if (key.startsWith('$')) return match;
      return vars[key] ?? `{{${key}}}`;
    }
  );
  return applyDynamicVariables(userResolved);
}
