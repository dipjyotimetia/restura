/**
 * The app's one send-time text resolver: request-scope values (collection, folder
 * and script values the store cannot see) in insertion order, then the store
 * resolver, with SecretRef-variable tokens kept away from the store so Electron
 * main can materialize them at the wire edge (ADR-0007).
 *
 * The HTTP executor and the GraphQL subscription handshake both resolve through
 * here, so what they send cannot diverge.
 */
import { expandVariablesInOrder } from '@shared/variables/resolver';
import { replaceSecretVariableTokenMatches } from '@shared/variables/secret-variable-token';

export interface RequestScope {
  /** Read at call time, so a script's writes to the map are seen by later fields. */
  values: Readonly<Record<string, string>>;
  secretVariables?: Readonly<Record<string, unknown>> | undefined;
  /** The store pass: environment, globals, then dynamics. */
  resolveVariables: (text: string) => string;
}

export function resolveRequestScopeText(text: string, scope: RequestScope): string {
  const { values, secretVariables, resolveVariables } = scope;
  let result = expandVariablesInOrder(text, Object.entries(values));
  const shielded = new Map<string, string>();
  if (secretVariables) {
    result = replaceSecretVariableTokenMatches(
      result,
      (name) => Object.hasOwn(secretVariables, name),
      (_name, token) => {
        const marker = `__restura_secret_${shielded.size}__`;
        shielded.set(marker, token);
        return marker;
      }
    );
  }
  result = resolveVariables(result);
  for (const [marker, token] of shielded) result = result.replaceAll(marker, token);
  return result;
}
