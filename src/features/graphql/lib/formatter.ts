import { parse, print } from 'graphql';

// Format/prettify a GraphQL query
export function formatQuery(query: string): string {
  if (!query.trim()) {
    return query;
  }

  try {
    const ast = parse(query);
    return print(ast);
  } catch {
    // If parsing fails, return original query
    return query;
  }
}

// Minify a GraphQL query (remove whitespace)
export function minifyQuery(query: string): string {
  if (!query.trim()) {
    return query;
  }

  try {
    const ast = parse(query);
    // print() pretty-prints across multiple lines, so collapse whitespace
    // afterwards to produce a minified single-line query.
    const printed = print(ast);
    return printed
      .replace(/\s+/g, ' ')
      .replace(/\s*([{}():,])\s*/g, '$1')
      .trim();
  } catch {
    return query;
  }
}

// Check if query can be parsed
export function isValidSyntax(query: string): boolean {
  if (!query.trim()) {
    return true;
  }

  try {
    parse(query);
    return true;
  } catch {
    return false;
  }
}
