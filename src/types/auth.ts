import type { SecretValue } from '@/lib/shared/secretRef';

// Authentication Types
export type AuthType =
  | 'none'
  | 'basic'
  | 'bearer'
  | 'api-key'
  | 'oauth2'
  | 'digest'
  | 'aws-signature'
  | 'oauth1'
  | 'ntlm'
  | 'wsse';

// Authentication Configuration
// Sensitive credential fields use `SecretValue` (string | SecretRef) per ADR-0007.
// Inline shapes mirror legacy plaintext; handle shapes are desktop-only and
// resolved main-process-side at the wire boundary.
//
// NOTE: a structural subset of this type is re-declared as `ProtocolAuthConfig`
// in `shared/protocol/types.ts`. The two must move in lockstep — the parity test
// `tests/auth-config-parity.test.ts` guards against drift.
export interface AuthConfig {
  type: AuthType;
  basic?: {
    username: string;
    password: SecretValue;
  };
  bearer?: {
    token: SecretValue;
  };
  apiKey?: {
    key: string;
    value: SecretValue;
    in: 'header' | 'query';
  };
  oauth2?: {
    accessToken: SecretValue;
    tokenType?: string;
    refreshToken?: SecretValue;
    expiresAt?: number;
    scopes?: string[];
    // Flow configuration
    grantType?: 'authorization_code' | 'client_credentials' | 'password' | 'device_code';
    clientId?: string;
    clientSecret?: SecretValue;
    authorizationUrl?: string;
    tokenUrl?: string;
    /** RFC 8628 device authorization endpoint — required for device_code grant */
    deviceAuthorizationUrl?: string;
    scope?: string;
    redirectUri?: string;
    // Password grant only
    username?: string;
    password?: SecretValue;
  };
  digest?: {
    username: string;
    password: SecretValue;
  };
  awsSignature?: {
    accessKey: string;
    secretKey: SecretValue;
    region: string;
    service: string;
  };
  oauth1?: {
    consumerKey: string;
    consumerSecret: SecretValue;
    accessToken?: SecretValue;
    accessTokenSecret?: SecretValue;
    /** Default HMAC-SHA1 if omitted. */
    signatureMethod?: 'HMAC-SHA1' | 'HMAC-SHA256' | 'PLAINTEXT';
    realm?: string;
    /** If set, used as-is. Otherwise generated per request. */
    nonce?: string;
    /** Unix seconds. If set, used as-is. Otherwise generated per request. */
    timestamp?: string;
    /** Add to body params for form-encoded POSTs (RFC 5849 §3.4.1.3.1). */
    addParamsToBody?: boolean;
  };
  /** NTLM is desktop-only (Electron). The browser/Worker emit a warning at request time. */
  ntlm?: {
    username: string;
    password: SecretValue;
    domain?: string;
    workstation?: string;
  };
  wsse?: {
    username: string;
    password: SecretValue;
    /** PasswordDigest = sha1(nonce + created + password) base64. PasswordText sends the password verbatim (avoid). */
    passwordType?: 'PasswordDigest' | 'PasswordText';
  };
}
