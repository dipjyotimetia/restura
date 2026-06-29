/**
 * Secret-detection regexes — the single source of truth shared by the AI
 * redactor (`ai/redaction.ts`) and the capture redactor
 * (`../capture/secret-extractor.ts`). Previously these were copied verbatim into
 * both, so a new token shape added to one silently leaked through the other.
 *
 * Exposed as FACTORIES, not shared arrays: the body patterns are `/g`
 * (stateful `lastIndex`) and one consumer uses `.test()`. Returning fresh
 * `RegExp` instances per call guarantees no cross-module `lastIndex` aliasing.
 *
 * Header denylist names (the exact set) live in `credential-header-names.ts`;
 * these are the regex layers on top.
 */

/** `x-*-token/key/secret` family + bare `api_key` (case-insensitive, non-global). */
export function headerDenylistRegex(): RegExp[] {
  return [/^x-.*-token$/i, /^x-.*-key$/i, /^x-.*-secret$/i, /^api[-_]?key$/i];
}

/** JWTs, Bearer tokens, `key=value` secrets, and prefixed provider/cloud tokens. */
export function bodyTokenPatterns(): RegExp[] {
  return [
    /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
    /Bearer\s+[A-Za-z0-9._\-+/=]{8,}/g,
    /(api[_-]?key|secret|password|token)["']?\s*[:=]\s*["']?[A-Za-z0-9._\-+/=]{8,}/gi,
    /\bsk-(?:ant-|or-v1-|proj-)?[A-Za-z0-9_-]{16,}/g, // OpenAI / Anthropic / OpenRouter keys
    /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
    /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g, // GitHub tokens
    /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, // GitHub fine-grained PAT
    /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens
    /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  ];
}
