/**
 * Small declarative expression evaluator for the Restura workflow profile.
 *
 * OWS leaves runtime-expression language selection to implementations. This
 * evaluator deliberately accepts only context paths, literals, comparisons,
 * boolean operators, and parentheses; it never evaluates user-provided code.
 */
type Token =
  | { kind: 'path'; value: string }
  | { kind: 'literal'; value: unknown }
  | { kind: 'operator'; value: '&&' | '||' | '!' | '==' | '!=' | '>' | '>=' | '<' | '<=' }
  | { kind: 'paren'; value: '(' | ')' };
type Operator = Extract<Token, { kind: 'operator' }>['value'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readOwsPath(context: Record<string, unknown>, expression: string): unknown {
  const normalized = expression
    .trim()
    .replace(/^\$\{\s*\.?/, '')
    .replace(/\s*\}$/, '');
  if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(normalized)) return undefined;
  let current: unknown = context;
  for (const segment of normalized.split('.')) {
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

export function isOwsPathExpression(expression: unknown): expression is string {
  return (
    typeof expression === 'string' &&
    /^\$\{\s*\.?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*\}$/.test(expression)
  );
}

export function resolveOwsValue(value: unknown, context: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    const exact = /^\$\{\s*\.?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*\}$/.exec(value);
    if (exact) return readOwsPath(context, value);
    return value.replace(/\$\{\s*\.?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*\}/g, (token) => {
      const resolved = readOwsPath(context, token);
      return resolved === undefined || resolved === null ? '' : String(resolved);
    });
  }
  if (Array.isArray(value)) return value.map((item) => resolveOwsValue(item, context));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveOwsValue(item, context)])
    );
  }
  return value;
}

function tokenize(source: string, context: Record<string, unknown>): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  const unsupported = () => {
    throw new Error(`OWS condition contains an unsupported token near '${source.slice(index)}'.`);
  };

  while (index < source.length) {
    const remaining = source.slice(index);
    const whitespace = /^\s+/.exec(remaining);
    if (whitespace) {
      index += whitespace[0].length;
      continue;
    }
    const path = /^\$\{\s*\.?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*\}/.exec(remaining);
    if (path) {
      tokens.push({ kind: 'path', value: path[0] });
      index += path[0].length;
      continue;
    }
    const operator = /^(\&\&|\|\||==|!=|>=|<=|>|<|!)/.exec(remaining);
    if (operator) {
      tokens.push({ kind: 'operator', value: operator[1] as Operator });
      index += operator[0].length;
      continue;
    }
    if (remaining.startsWith('(') || remaining.startsWith(')')) {
      tokens.push({ kind: 'paren', value: remaining[0] as '(' | ')' });
      index += 1;
      continue;
    }
    const stringLiteral = /^"(?:[^"\\]|\\.)*"/.exec(remaining);
    if (stringLiteral) {
      tokens.push({ kind: 'literal', value: JSON.parse(stringLiteral[0]) });
      index += stringLiteral[0].length;
      continue;
    }
    const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?/.exec(remaining);
    if (number) {
      tokens.push({ kind: 'literal', value: Number(number[0]) });
      index += number[0].length;
      continue;
    }
    const keyword = /^(true|false|null)(?![A-Za-z0-9_$])/.exec(remaining);
    if (keyword) {
      tokens.push({
        kind: 'literal',
        value: keyword[1] === 'true' ? true : keyword[1] === 'false' ? false : null,
      });
      index += keyword[0].length;
      continue;
    }
    unsupported();
  }

  // Resolve paths only after tokenization so no context value can affect parsing.
  return tokens.map((token) =>
    token.kind === 'path'
      ? { kind: 'literal' as const, value: readOwsPath(context, token.value) }
      : token
  );
}

class Parser {
  private readonly tokens: Token[];
  private index = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parse(): boolean {
    if (this.tokens.length === 0) throw new Error('OWS condition may not be empty.');
    const value = this.parseOr();
    if (this.peek()) throw new Error('OWS condition contains an unsupported expression suffix.');
    return Boolean(value);
  }

  private parseOr(): unknown {
    let value = this.parseAnd();
    while (this.consumeOperator('||')) {
      const right = this.parseAnd();
      value = Boolean(value) || Boolean(right);
    }
    return value;
  }

  private parseAnd(): unknown {
    let value = this.parseComparison();
    while (this.consumeOperator('&&')) {
      const right = this.parseComparison();
      value = Boolean(value) && Boolean(right);
    }
    return value;
  }

  private parseComparison(): unknown {
    let value = this.parseUnary();
    const token = this.peek();
    if (token?.kind !== 'operator' || !['==', '!=', '>', '>=', '<', '<='].includes(token.value)) {
      return value;
    }
    this.index += 1;
    const right = this.parseUnary();
    switch (token.value) {
      case '==':
        return value === right;
      case '!=':
        return value !== right;
      case '>':
        return typeof value === 'number' && typeof right === 'number' && value > right;
      case '>=':
        return typeof value === 'number' && typeof right === 'number' && value >= right;
      case '<':
        return typeof value === 'number' && typeof right === 'number' && value < right;
      case '<=':
        return typeof value === 'number' && typeof right === 'number' && value <= right;
      default:
        throw new Error('OWS condition contains an unsupported comparison.');
    }
  }

  private parseUnary(): unknown {
    if (this.consumeOperator('!')) return !Boolean(this.parseUnary());
    const token = this.peek();
    if (token?.kind === 'paren' && token.value === '(') {
      this.index += 1;
      const value = this.parseOr();
      const closing = this.peek();
      if (closing?.kind !== 'paren' || closing.value !== ')') {
        throw new Error('OWS condition has an unclosed parenthesis.');
      }
      this.index += 1;
      return value;
    }
    if (token?.kind === 'literal') {
      this.index += 1;
      return token.value;
    }
    throw new Error('OWS condition expects a context path or JSON literal.');
  }

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }

  private consumeOperator(operator: Token['value']): boolean {
    const token = this.peek();
    if (token?.kind !== 'operator' || token.value !== operator) return false;
    this.index += 1;
    return true;
  }
}

export function evaluateOwsCondition(source: string, context: Record<string, unknown>): boolean {
  return new Parser(tokenize(source, context)).parse();
}
