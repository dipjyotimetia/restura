import { findVariableTokens, tokenDisplayStatus } from '@/lib/shared/variableTokens';
import type { AuthConfig, AuthType, HttpRequest } from '@/types';

type GetStatus = (name: string) => 'resolved' | 'unresolved';

const AUTH_CONFIG_KEY: Partial<Record<AuthType, Exclude<keyof AuthConfig, 'type'>>> = {
  basic: 'basic',
  bearer: 'bearer',
  'api-key': 'apiKey',
  oauth2: 'oauth2',
  digest: 'digest',
  'aws-signature': 'awsSignature',
  oauth1: 'oauth1',
  ntlm: 'ntlm',
  wsse: 'wsse',
};

/** Every string inside an auth config (token, username, key, OAuth fields…). */
function collectAuthStrings(value: unknown, out: string[], depth = 0): void {
  if (depth > 6 || value === null || value === undefined) return;
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectAuthStrings(item, out, depth + 1);
    return;
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value)) collectAuthStrings(item, out, depth + 1);
  }
}

/** The text fields of a request that the send path substitutes `{{vars}}` in. */
function sentTexts(request: HttpRequest): string[] {
  const texts: string[] = [request.url];
  for (const p of request.params) if (p.enabled) texts.push(p.key, p.value);
  for (const p of request.pathVariables ?? []) if (p.enabled) texts.push(p.value);
  for (const h of request.headers) if (h.enabled) texts.push(h.key, h.value);

  const { body } = request;
  switch (body.type) {
    case 'none':
    case 'binary':
      break;
    // Fields are the source of truth here; `raw` may be a stale text view.
    case 'form-data':
    case 'x-www-form-urlencoded':
      for (const f of body.formData ?? []) {
        if (f.enabled && f.type !== 'file') texts.push(f.key, f.value);
      }
      break;
    case 'graphql':
      texts.push(body.raw ?? '', body.graphqlVariables ?? '');
      break;
    default:
      texts.push(body.raw ?? '');
  }

  // Only the active auth type's fields go out; others may be stale leftovers.
  const authKey = AUTH_CONFIG_KEY[request.auth.type];
  if (authKey) collectAuthStrings(request.auth[authKey], texts);
  return texts;
}

/**
 * `{{var}}` names the request references that won't resolve when sent, in
 * first-seen order, deduplicated. Uses the same token grammar and classifier as
 * the inline highlights (`useVariableStatus`), so the warning and the
 * highlights never disagree.
 */
export function findUnresolvedVariables(request: HttpRequest, getStatus: GetStatus): string[] {
  const names = new Set<string>();
  for (const text of sentTexts(request)) {
    if (!text || !text.includes('{{')) continue;
    for (const token of findVariableTokens(text)) {
      if (tokenDisplayStatus(token.name, getStatus) === 'unresolved') names.add(token.name);
    }
  }
  return Array.from(names);
}
