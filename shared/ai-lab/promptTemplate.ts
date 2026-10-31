// Tiny {{var}} template engine for AI Lab prompts. Deliberately minimal — no
// logic/conditionals, just named substitution from a dataset case's vars. An
// unknown placeholder renders empty (and is reported by `missingVars`).

const PLACEHOLDER = /\{\{\s*([\w.-]+)\s*\}\}/g;

export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(PLACEHOLDER, (_m, key: string) => vars[key] ?? '');
}

/** Distinct placeholder names referenced by the template, in first-seen order. */
export function extractVars(template: string): string[] {
  const seen = new Set<string>();
  for (const m of template.matchAll(PLACEHOLDER)) {
    const key = m[1];
    if (key) seen.add(key);
  }
  return [...seen];
}

/** Placeholders the template references that the case doesn't supply. */
export function missingVars(template: string, vars: Record<string, string>): string[] {
  return extractVars(template).filter((k) => !(k in vars));
}
