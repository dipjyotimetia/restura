import type { AuthConfig, HttpRequest } from '@/types';
import { isSecretHandle, type SecretValue } from '../secretRef';
import { serializeUrlEncoded } from '../urlEncodedBody';
import type { GenerateOptions } from './types';

export interface CodegenInput {
  request: HttpRequest;
  /** Effective auth (the request's own, or the folder/collection auth it inherits). */
  auth: AuthConfig;
  /** Variable values from every scope the request resolves against. */
  values: Record<string, string>;
  /** Variables whose values must not be printed (marked secret, or desktop handles). */
  secretNames: ReadonlySet<string>;
  /** Replace secrets and credentials with placeholders (default in the UI). */
  maskSecrets: boolean;
}

/**
 * Turn a request into resolved generator inputs: substitute variables from all
 * scopes, fold auth into headers/params, expand form-data, and collect notes
 * for anything a snippet can't reproduce. Secrets are never resolved from
 * desktop handles (the renderer never has them) and are masked on request.
 */
export function prepareCodegen(input: CodegenInput): GenerateOptions & { notes: string[] } {
  const { request, auth, values, secretNames, maskSecrets } = input;
  const notes: string[] = [];

  const resolve = (text: string): string =>
    text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (token, name: string) => {
      if (secretNames.has(name) && (maskSecrets || !(name in values))) return token;
      return name in values ? (values[name] as string) : token;
    });

  const resolvedHeaders: Record<string, string> = {};
  for (const h of request.headers)
    if (h.enabled && h.key) resolvedHeaders[h.key] = resolve(h.value);
  const resolvedParams: Record<string, string> = {};
  for (const p of request.params) if (p.enabled && p.key) resolvedParams[p.key] = resolve(p.value);

  const secret = (value: SecretValue | undefined, placeholder: string): string => {
    if (value === undefined) return '';
    if (isSecretHandle(value) || maskSecrets) return placeholder;
    return resolve(typeof value === 'string' ? value : value.kind === 'inline' ? value.value : '');
  };
  const hasHeader = (name: string) =>
    Object.keys(resolvedHeaders).some((k) => k.toLowerCase() === name.toLowerCase());
  const setAuthorization = (value: string) => {
    if (!hasHeader('Authorization')) resolvedHeaders.Authorization = value;
  };

  switch (auth.type) {
    case 'basic': {
      const user = resolve(auth.basic?.username ?? '');
      const password = auth.basic?.password;
      const masked = maskSecrets || (password !== undefined && isSecretHandle(password));
      setAuthorization(
        masked
          ? 'Basic <base64(username:password)>'
          : `Basic ${toBase64(`${user}:${secret(password, '')}`)}`
      );
      break;
    }
    case 'bearer':
      setAuthorization(`Bearer ${secret(auth.bearer?.token, '<token>')}`);
      break;
    case 'oauth2':
      if (auth.oauth2?.accessToken) {
        const type = auth.oauth2.tokenType || 'Bearer';
        setAuthorization(`${type} ${secret(auth.oauth2.accessToken, '<access-token>')}`);
      } else {
        notes.push('OAuth 2.0 has no access token yet; fetch one and add an Authorization header.');
      }
      break;
    case 'api-key': {
      const key = auth.apiKey?.key;
      if (key) {
        const value = secret(auth.apiKey?.value, '<api-key>');
        if (auth.apiKey?.in === 'query') resolvedParams[key] = value;
        else if (!hasHeader(key)) resolvedHeaders[key] = value;
      }
      break;
    }
    case 'digest':
    case 'ntlm':
    case 'aws-signature':
    case 'oauth1':
    case 'wsse':
      notes.push(
        `${AUTH_LABELS[auth.type]} auth is computed per request (challenge or signature) and isn't included. Configure it in your HTTP client.`
      );
      break;
    default:
      break;
  }

  const body = request.body;
  const formData =
    body.type === 'form-data'
      ? (body.formData ?? [])
          .filter((f) => f.enabled && f.key)
          .map((f) =>
            f.type === 'file'
              ? { key: f.key, value: f.fileName || 'file', type: 'file' as const }
              : { key: f.key, value: resolve(f.value), type: 'text' as const }
          )
      : undefined;
  if (body.type === 'binary')
    notes.push('The binary body isn’t included; attach the file in your client.');

  // Imported urlencoded bodies carry fields rather than a raw string; the
  // app sends those fields, so the snippet does too.
  const urlEncodedFields =
    body.type === 'x-www-form-urlencoded'
      ? (body.formData ?? []).filter((f) => f.enabled && f.key && f.type !== 'file')
      : [];
  const raw =
    urlEncodedFields.length > 0
      ? serializeUrlEncoded(urlEncodedFields.map((f) => ({ key: f.key, value: resolve(f.value) })))
      : body.raw !== undefined
        ? resolve(body.raw)
        : undefined;
  const resolvedRequest: HttpRequest =
    raw !== undefined && body.type !== 'binary' ? { ...request, body: { ...body, raw } } : request;

  // Match the app, which sends XML with this Content-Type unless one is set.
  if (body.type === 'xml' && !hasHeader('Content-Type')) {
    resolvedHeaders['Content-Type'] = 'application/xml';
  }

  return {
    request: resolvedRequest,
    resolvedUrl: resolve(request.url),
    resolvedHeaders,
    resolvedParams,
    ...(formData ? { formData } : {}),
    notes,
  };
}

const AUTH_LABELS: Record<string, string> = {
  digest: 'Digest',
  ntlm: 'NTLM',
  'aws-signature': 'AWS Signature v4',
  oauth1: 'OAuth 1.0',
  wsse: 'WSSE',
};

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const COMMENT_PREFIX: Record<string, string> = {
  curl: '#',
  python: '#',
  ruby: '#',
  javascript: '//',
  nodejs: '//',
  go: '//',
  php: '//',
};

/** Prepend notes as comments in the target language's syntax. */
export function withNotes(code: string, language: string, notes: readonly string[]): string {
  if (notes.length === 0) return code;
  const prefix = COMMENT_PREFIX[language] ?? '//';
  const block = notes.map((n) => `${prefix} Note: ${n}`).join('\n');
  // PHP comments must sit inside the <?php block.
  if (code.startsWith('<?php\n')) return `<?php\n${block}\n${code.slice(6)}`;
  return `${block}\n${code}`;
}

/** Languages whose generator emits multipart bodies from `formData`. */
export const FORM_DATA_LANGUAGES: ReadonlySet<string> = new Set(['curl', 'python', 'javascript']);
