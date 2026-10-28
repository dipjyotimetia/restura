/**
 * Effective handshake credentials for a GraphQL subscription (#878, #882).
 *
 * A subscription opens a `graphql-transport-ws` socket instead of POSTing
 * through the HTTP executor, so it must rebuild the same auth a query on the
 * tab would send: folder/collection-inherited auth, `{{vars}}` resolved (in the
 * URL, headers and the auth fields), and API keys configured `in: query`
 * appended to the socket URL.
 *
 * SecretRef handles (ADR-0007) and SecretRef-backed variables are never
 * resolved here. On desktop the (minimal) auth descriptor and the referenced
 * secret-variable refs ride the WebSocket IPC connect call and are resolved in
 * Electron main at wire time (`electron/main/security/ws-handshake-auth.ts`),
 * so plaintext never reaches the renderer. On web they can't be resolved at
 * all and are reported back as `unapplied` instead of being sent literally.
 */
import { resolveEffectiveAuth } from '@/features/auth/lib/authInheritance';
import { buildAuthCredential } from '@/features/auth/lib/buildAuthCredential';
import { resolveAuthVariables } from '@/features/auth/lib/resolveAuthVariables';
import { resolveInheritedAuthForSend } from '@/features/auth/lib/resolveInheritedAuthFor';
import { buildActiveRequestVariableResolution } from '@/lib/shared/activeRequestScopes';
import { escapeRegExp } from '@/lib/shared/escapeRegExp';
import { isElectron } from '@/lib/shared/platform';
import type { SecretValue } from '@/lib/shared/secretRef';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import type { AuthConfig, AuthType, HttpRequest } from '@/types';

/** Auth that only exists as a wire signature / challenge — no upgrade-request analogue. */
const SIGN_AT_WIRE_LABELS: Partial<Record<AuthType, string>> = {
  digest: 'Digest',
  oauth1: 'OAuth 1.0',
  'aws-signature': 'AWS Signature',
  ntlm: 'NTLM',
  wsse: 'WSSE',
};

export interface SubscriptionHandshake {
  /** HTTP(S) endpoint, variables resolved, query-param API key appended. */
  url: string;
  /** Handshake headers the renderer could resolve (user headers + inline auth). */
  headers: Record<string, string>;
  /** `connection_init` payload — the renderer-resolved headers minus secret tokens. */
  connectionParams: Record<string, string>;
  /**
   * Desktop only: material Electron main resolves at wire time. `auth` is the
   * header-shaped auth descriptor (handles stay handles); `secretVariables` are
   * the SecretRef-backed variables referenced from the URL/headers/auth.
   */
  mainSide?: {
    auth?: AuthConfig;
    secretVariables?: Record<string, SecretValue>;
  };
  /** Credentials that are configured but won't be sent — surface to the user. */
  unapplied: string[];
}

export interface SubscriptionHandshakeInput {
  request: HttpRequest;
  /** Folder/collection auth the request inherits (only used when it has none). */
  inheritedAuth?: AuthConfig;
  /** Renderer-safe variable values (active request scopes). */
  values: Record<string, string>;
  /** SecretRef-backed variables — opaque to the renderer. */
  secretVariables: Record<string, SecretValue>;
  /** Store-level resolver (dynamic vars etc.), applied after `values`. */
  resolveVariables: (text: string) => string;
  /** True on the Electron harness (handles can be resolved main-side). */
  desktop: boolean;
}

/** Keep only the field the auth type actually uses — nothing else crosses IPC. */
function pickHeaderAuth(auth: AuthConfig): AuthConfig {
  switch (auth.type) {
    case 'bearer':
      return { type: 'bearer', ...(auth.bearer ? { bearer: auth.bearer } : {}) };
    case 'basic':
      return { type: 'basic', ...(auth.basic ? { basic: auth.basic } : {}) };
    case 'api-key':
      return { type: 'api-key', ...(auth.apiKey ? { apiKey: auth.apiKey } : {}) };
    case 'oauth2':
      return auth.oauth2
        ? {
            type: 'oauth2',
            oauth2: {
              accessToken: auth.oauth2.accessToken,
              ...(auth.oauth2.tokenType ? { tokenType: auth.oauth2.tokenType } : {}),
            },
          }
        : { type: 'oauth2' };
    default:
      return { type: 'none' };
  }
}

/** Plain-string credential fields of a header-shaped auth descriptor. */
function authStrings(auth: AuthConfig): string[] {
  const out: string[] = [];
  const push = (v: SecretValue | undefined) => {
    if (typeof v === 'string') out.push(v);
    else if (v?.kind === 'inline') out.push(v.value);
  };
  push(auth.bearer?.token);
  push(auth.basic?.username);
  push(auth.basic?.password);
  push(auth.apiKey?.key);
  push(auth.apiKey?.value);
  push(auth.oauth2?.accessToken);
  push(auth.oauth2?.tokenType);
  return out;
}

/**
 * `{{name}}` with optional inner whitespace — the same token grammar Electron
 * main's `replaceSecretVariableTokens` accepts, so `{{ apiSecret }}` is
 * detected and shielded too.
 */
function secretTokenPattern(name: string, flags = ''): RegExp {
  return new RegExp(`\\{\\{\\s*${escapeRegExp(name)}\\s*\\}\\}`, flags);
}

function referencedSecrets(texts: string[], secretVariables: Record<string, SecretValue>) {
  return Object.keys(secretVariables).filter((name) => {
    const pattern = secretTokenPattern(name);
    return texts.some((text) => pattern.test(text));
  });
}

function appendQueryParams(url: string, params: Record<string, string>): string {
  const entries = Object.entries(params);
  if (entries.length === 0) return url;
  try {
    const parsed = new URL(url);
    for (const [k, v] of entries) parsed.searchParams.append(k, v);
    return parsed.toString();
  } catch {
    const query = entries
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    const [base, hash] = url.split('#', 2);
    const sep = base?.includes('?') ? '&' : '?';
    return `${base}${sep}${query}${hash !== undefined ? `#${hash}` : ''}`;
  }
}

/** Pure core — see {@link prepareSubscriptionHandshake} for the store-aware entry. */
export function buildSubscriptionHandshake(
  input: SubscriptionHandshakeInput
): SubscriptionHandshake {
  const { request, values, secretVariables, desktop } = input;
  const unapplied: string[] = [];

  // Same resolution as the HTTP executor's resolveLocal: request-scope values
  // first, then the store resolver — with SecretRef-variable tokens shielded so
  // the store resolver can't consume them before Electron main materializes them.
  const resolve = (text: string): string => {
    let result = text;
    for (const [key, value] of Object.entries(values)) {
      result = result.replace(new RegExp(`{{${escapeRegExp(key)}}}`, 'g'), () => value);
    }
    const shielded = new Map<string, string>();
    for (const key of Object.keys(secretVariables)) {
      const pattern = secretTokenPattern(key, 'g');
      if (secretTokenPattern(key).test(result)) {
        const marker = `__restura_secret_${shielded.size}__`;
        result = result.replace(pattern, marker);
        // Restore the canonical token (main resolves either form).
        shielded.set(marker, `{{${key}}}`);
      }
    }
    result = input.resolveVariables(result);
    for (const [marker, token] of shielded) result = result.replaceAll(marker, token);
    return result;
  };

  let url = resolve(request.url);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  for (const header of request.headers) {
    if (header.enabled && header.key) headers[resolve(header.key)] = resolve(header.value);
  }

  const effectiveAuth = resolveAuthVariables(
    resolveEffectiveAuth(request.auth, input.inheritedAuth),
    resolve
  );
  let mainSideAuth: AuthConfig | undefined;

  const signLabel = SIGN_AT_WIRE_LABELS[effectiveAuth.type];
  if (signLabel) {
    unapplied.push(
      `${signLabel} auth isn't applied to subscriptions — a WebSocket upgrade has no body or challenge round-trip to sign. The subscription is opened without it.`
    );
  } else if (effectiveAuth.type !== 'none') {
    const credential = buildAuthCredential(effectiveAuth);
    const authSecretRefs = referencedSecrets(authStrings(effectiveAuth), secretVariables);
    if (credential.requiresMainSideApply || authSecretRefs.length > 0) {
      if (desktop) {
        mainSideAuth = pickHeaderAuth(effectiveAuth);
      } else {
        unapplied.push(
          'This auth uses a keychain-stored secret, which only the Restura desktop app can resolve. The subscription is opened without it.'
        );
      }
    } else {
      Object.assign(headers, credential.headers);
      url = appendQueryParams(url, credential.params);
    }
  }

  // Secret-variable tokens left in the URL/headers (and in a main-side auth).
  const headerTexts = Object.entries(headers).flat();
  const wireSecrets = referencedSecrets(
    [url, ...headerTexts, ...(mainSideAuth ? authStrings(mainSideAuth) : [])],
    secretVariables
  );
  const secretSubset: Record<string, SecretValue> = {};
  for (const name of wireSecrets) {
    const ref = secretVariables[name];
    if (ref !== undefined) secretSubset[name] = ref;
  }
  if (!desktop && wireSecrets.length > 0) {
    unapplied.push(
      `Secret variable${wireSecrets.length > 1 ? 's' : ''} ${wireSecrets.map((n) => `{{${n}}}`).join(', ')} can only be resolved by the Restura desktop app.`
    );
  }

  // connection_init only carries what the renderer itself resolved — never a
  // secret token (the value lives main-side, and the name alone is useless).
  const connectionParams: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (referencedSecrets([key, value], secretVariables).length === 0) {
      connectionParams[key] = value;
    }
  }

  const mainSide =
    desktop && (mainSideAuth || wireSecrets.length > 0)
      ? {
          ...(mainSideAuth ? { auth: mainSideAuth } : {}),
          ...(wireSecrets.length > 0 ? { secretVariables: secretSubset } : {}),
        }
      : undefined;

  return { url, headers, connectionParams, ...(mainSide ? { mainSide } : {}), unapplied };
}

/**
 * Build the subscription handshake for the active tab's request from the live
 * stores: inherited auth, the active request's variable scopes, the
 * environment resolver and the current harness.
 */
export function prepareSubscriptionHandshake(request: HttpRequest): SubscriptionHandshake {
  const { values, secretVariables } = buildActiveRequestVariableResolution();
  // Refuses a Postman-guard-blocked request (#1232).
  const inherited = resolveInheritedAuthForSend(request);
  return buildSubscriptionHandshake({
    request,
    ...(inherited ? { inheritedAuth: inherited.auth } : {}),
    values,
    secretVariables,
    resolveVariables: (text) => useEnvironmentStore.getState().resolveVariables(text),
    desktop: isElectron(),
  });
}
