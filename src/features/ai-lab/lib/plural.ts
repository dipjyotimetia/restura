/** "1 model" / "3 models" — replaces the lazy "model(s)" copy. */
export function plural(n: number, singular: string, pluralForm?: string): string {
  return `${n} ${n === 1 ? singular : (pluralForm ?? `${singular}s`)}`;
}
