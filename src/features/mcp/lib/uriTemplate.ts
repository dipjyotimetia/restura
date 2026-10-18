/**
 * RFC 6570 URI Template support for MCP resource templates (string values only).
 *
 * Implements level 1 (`{var}`), level 2 (`{+var}`, `{#var}`) and the level 3
 * operators (`.`, `/`, `;`, `?`, `&`, multiple comma-separated variables), plus
 * the `:n` prefix modifier. The explode modifier (`*`) is accepted and is a
 * no-op for string values. Every substituted value is percent-encoded:
 * unreserved characters only for simple/label/path/param/query operators, and
 * unreserved + reserved (keeping existing `%XX` triplets) for `+` and `#`.
 */

export interface UriTemplateVariable {
  name: string;
  /** `:n` prefix length, when present. */
  maxLength?: number;
}

export type UriTemplatePart =
  | { kind: 'literal'; text: string }
  | { kind: 'expression'; operator: string; variables: UriTemplateVariable[] };

const OPERATORS = '+#./;?&';

interface OperatorSpec {
  first: string;
  sep: string;
  named: boolean;
  ifEmpty: string;
  allowReserved: boolean;
}

const SPECS: Record<string, OperatorSpec> = {
  '': { first: '', sep: ',', named: false, ifEmpty: '', allowReserved: false },
  '+': { first: '', sep: ',', named: false, ifEmpty: '', allowReserved: true },
  '#': { first: '#', sep: ',', named: false, ifEmpty: '', allowReserved: true },
  '.': { first: '.', sep: '.', named: false, ifEmpty: '', allowReserved: false },
  '/': { first: '/', sep: '/', named: false, ifEmpty: '', allowReserved: false },
  ';': { first: ';', sep: ';', named: true, ifEmpty: '', allowReserved: false },
  '?': { first: '?', sep: '&', named: true, ifEmpty: '=', allowReserved: false },
  '&': { first: '&', sep: '&', named: true, ifEmpty: '=', allowReserved: false },
};

const VARNAME = /^[A-Za-z0-9_%.]+$/;

export function parseUriTemplate(template: string): UriTemplatePart[] {
  const parts: UriTemplatePart[] = [];
  let literal = '';
  let i = 0;
  while (i < template.length) {
    const ch = template[i] as string;
    if (ch !== '{') {
      literal += ch;
      i++;
      continue;
    }
    const end = template.indexOf('}', i);
    if (end === -1) {
      literal += template.slice(i);
      break;
    }
    const body = template.slice(i + 1, end);
    const first = body.charAt(0);
    const operator = first !== '' && OPERATORS.includes(first) ? first : '';
    const specs = (operator ? body.slice(1) : body).split(',');
    const variables: UriTemplateVariable[] = [];
    let valid = true;
    for (const raw of specs) {
      const m = /^([^:*]+)(?::(\d{1,4})|\*)?$/.exec(raw);
      if (!m || !VARNAME.test(m[1] as string)) {
        valid = false;
        break;
      }
      variables.push({
        name: m[1] as string,
        ...(m[2] ? { maxLength: Number(m[2]) } : {}),
      });
    }
    if (!valid) {
      // Malformed expression: keep it as literal text rather than guessing.
      literal += template.slice(i, end + 1);
    } else {
      if (literal) parts.push({ kind: 'literal', text: literal });
      literal = '';
      parts.push({ kind: 'expression', operator, variables });
    }
    i = end + 1;
  }
  if (literal) parts.push({ kind: 'literal', text: literal });
  return parts;
}

/** Distinct variable names in order of first appearance. */
export function getUriTemplateVariables(template: string): string[] {
  const names: string[] = [];
  for (const part of parseUriTemplate(template)) {
    if (part.kind !== 'expression') continue;
    for (const v of part.variables) if (!names.includes(v.name)) names.push(v.name);
  }
  return names;
}

/** Whether a variable may legitimately be left blank (form-style `;`, `?`, `&` operators). */
export function isOptionalUriTemplateVariable(template: string, name: string): boolean {
  return parseUriTemplate(template).some(
    (p) =>
      p.kind === 'expression' &&
      ';?&'.includes(p.operator || '\0') &&
      p.variables.some((v) => v.name === name)
  );
}

function encodeUnreserved(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function encodeReserved(value: string): string {
  // Keep reserved characters and already-encoded triplets; encode the rest.
  return value
    .split(/(%[0-9A-Fa-f]{2})/)
    .map((chunk, idx) =>
      idx % 2 === 1 ? chunk : encodeURI(chunk).replace(/%5B/gi, '[').replace(/%5D/gi, ']')
    )
    .join('');
}

function truncate(value: string, max: number | undefined): string {
  return max === undefined ? value : Array.from(value).slice(0, max).join('');
}

/**
 * Expand a template with string values. A variable that is `undefined` (or
 * absent) is undefined per RFC 6570 and is skipped; an empty string is a
 * defined, empty value.
 */
export function expandUriTemplate(template: string, values: Record<string, string>): string {
  let out = '';
  for (const part of parseUriTemplate(template)) {
    if (part.kind === 'literal') {
      out += part.text;
      continue;
    }
    const spec = SPECS[part.operator] as OperatorSpec;
    const encode = spec.allowReserved ? encodeReserved : encodeUnreserved;
    const pieces: string[] = [];
    for (const variable of part.variables) {
      const raw = values[variable.name];
      if (raw === undefined) continue;
      const encoded = encode(truncate(raw, variable.maxLength));
      if (spec.named) {
        pieces.push(
          encoded === '' ? `${variable.name}${spec.ifEmpty}` : `${variable.name}=${encoded}`
        );
      } else {
        pieces.push(encoded);
      }
    }
    if (pieces.length > 0) out += spec.first + pieces.join(spec.sep);
  }
  return out;
}
