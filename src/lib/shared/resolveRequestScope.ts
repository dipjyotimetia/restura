/**
 * The app's one send-time text resolver: request-scope values (collection, folder
 * and script values the store cannot see) in insertion order, then the store
 * resolver, with SecretRef-variable tokens kept away from the store so Electron
 * main can materialize them at the wire edge (ADR-0007).
 *
 * A secret variable, SecretRef-backed or plaintext, resolves only from a token
 * written in the text being resolved. Such tokens are shielded before any
 * expansion; a secret token still present afterwards came through a value, and
 * the send is refused. Electron main cannot tell where a token came from, so the
 * decision is made here, field by field.
 *
 * The HTTP executor and the GraphQL subscription handshake both resolve through
 * here, so what they send cannot diverge.
 */
import {
  expandVariablesInOrder,
  restoreShieldedTokens,
  type ShieldedToken,
  shieldedEntries,
  shieldVariableTokens,
} from '@shared/variables/resolver';
import { SecretVariableReferenceError } from '@shared/variables/secret-variable-token';
import { scanVariableTokens } from '@shared/variables/tokens';

export interface RequestScope {
  /** Read at call time, so a script's writes to the map are seen by later fields. */
  values: Readonly<Record<string, string>>;
  secretVariables?: Readonly<Record<string, unknown>> | undefined;
  /** Every name that resolves only where it is written, beyond `secretVariables`. */
  secretNames?: readonly string[] | undefined;
  /** The store pass: environment, globals, then dynamics. */
  resolveVariables: (text: string) => string;
}

/** The variable whose value holds a token for `secret`, for the refusal message. */
function describeReferrer(secret: string, values: Readonly<Record<string, string>>): string {
  for (const [key, value] of Object.entries(values)) {
    if (key.trim() === secret) continue;
    if (scanVariableTokens(String(value)).some((token) => token.name === secret)) {
      return `Variable "${key.trim()}"`;
    }
  }
  return 'A variable';
}

export function resolveRequestScopeText(
  text: string,
  scope: RequestScope,
  /** Where `text` is going (`URL`, `header "X-Key"`), for the refusal message. */
  field?: string
): string {
  const { values, secretVariables, secretNames, resolveVariables } = scope;
  const names = new Set(secretNames);
  const isHandle = (name: string) =>
    secretVariables !== undefined && Object.hasOwn(secretVariables, name);
  const isSecret = (name: string) => names.has(name) || isHandle(name);

  const refuseSecretTokens = (candidate: string) => {
    const token = scanVariableTokens(candidate).find(({ name }) => isSecret(name));
    if (token) {
      const source = describeReferrer(token.name, values);
      throw new SecretVariableReferenceError(source, token.name, field);
    }
  };

  const shield = shieldVariableTokens(text, isSecret);
  let result = expandVariablesInOrder(
    shield.text,
    shieldedEntries(Object.entries(values), shield, isSecret)
  );
  // Checked before the store pass too: the store takes its input as written, so
  // it would answer a token that really came through a value.
  refuseSecretTokens(result);
  result = resolveVariables(result);
  refuseSecretTokens(result);

  // A plaintext secret the request scope has no value for: only the store can
  // answer, and this token was written in the field. An answer can complete a
  // token with the text around it, so the joined text is checked while every
  // other written token is still a marker.
  const answers = new Map<string, ShieldedToken>();
  for (const { name: marker } of scanVariableTokens(result)) {
    const token = shield.tokens.get(marker);
    if (!token || isHandle(token.name)) continue;
    const answer = resolveVariables(token.raw);
    if (answer !== token.raw) answers.set(marker, { ...token, raw: answer });
  }
  const joined = restoreShieldedTokens(result, { text: shield.text, tokens: answers });
  refuseSecretTokens(joined);
  return restoreShieldedTokens(joined, shield);
}

/** `values` without the secret names, for a later walk that must not answer them. */
export function withoutSecretNames(
  values: Readonly<Record<string, string>>,
  secretNames: readonly string[]
): Record<string, string> {
  if (secretNames.length === 0) return values as Record<string, string>;
  const names = new Set(secretNames);
  return Object.fromEntries(Object.entries(values).filter(([key]) => !names.has(key.trim())));
}

/**
 * The secret rule over a plain map walk (the registry's `{{var}}` substitution).
 * With no secret names this is exactly `walk(text, values)`.
 */
export function resolveMapText(
  text: string,
  values: Readonly<Record<string, string>>,
  secretNames: readonly string[] | undefined,
  walk: (text: string, values: Record<string, string>) => string,
  field?: string
): string {
  if (!secretNames?.length) return walk(text, values as Record<string, string>);
  return resolveRequestScopeText(
    text,
    {
      values,
      secretNames,
      resolveVariables: (rest) => walk(rest, withoutSecretNames(values, secretNames)),
    },
    field
  );
}
