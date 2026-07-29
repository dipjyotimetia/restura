import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const MAX_POLICY_BYTES = 256 * 1024;
const MAX_CA_BUNDLE_BYTES = 2 * 1024 * 1024;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/;
const UPDATE_HEADER = /^(authorization|x-[a-z0-9-]{1,62})$/i;

const HttpsUrlSchema = z
  .string()
  .url()
  .max(2048)
  .refine((value) => new URL(value).protocol === 'https:', 'HTTPS URL required');

const ProxyUrlSchema = z
  .string()
  .url()
  .max(2048)
  .refine(
    (value) => ['http:', 'https:'].includes(new URL(value).protocol),
    'HTTP or HTTPS proxy URL required'
  )
  .refine((value) => {
    const url = new URL(value);
    return !url.username && !url.password;
  }, 'Proxy credentials must use environment references');

const AbsoluteFilePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) => path.posix.isAbsolute(value) || path.win32.isAbsolute(value),
    'Absolute file path required'
  );

const IntegratedDomainSchema = z
  .string()
  .min(1)
  .max(253)
  .transform((value) => value.toLowerCase())
  .refine((value) => {
    const hostname = value.startsWith('*.') ? value.slice(2) : value;
    if (!hostname || hostname.includes('://') || hostname.includes(':')) return false;
    return hostname
      .split('.')
      .every(
        (label) =>
          label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
      );
  }, 'DNS hostname or leading wildcard required');

const ProxyAuthenticationSchema = z
  .object({
    basic: z
      .array(
        z
          .object({
            proxyUrl: ProxyUrlSchema,
            usernameEnv: z.string().regex(ENV_NAME),
            passwordEnv: z.string().regex(ENV_NAME),
          })
          .strict()
      )
      .max(20),
    integratedDomains: z.array(IntegratedDomainSchema).max(100),
  })
  .strict()
  .superRefine((authentication, ctx) => {
    const origins = authentication.basic.map((entry) => new URL(entry.proxyUrl).origin);
    if (new Set(origins).size !== origins.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['basic'],
        message: 'Basic proxy credential mappings must use unique proxy origins',
      });
    }
    if (
      new Set(authentication.integratedDomains).size !== authentication.integratedDomains.length
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['integratedDomains'],
        message: 'Integrated authentication domains must be unique',
      });
    }
  });

const ManagedNetworkPolicySchema = z
  .object({
    mode: z.enum(['system', 'fixed', 'pac', 'direct']),
    requireProxy: z.boolean(),
    proxyUrl: ProxyUrlSchema.optional(),
    pacUrl: HttpsUrlSchema.optional(),
    bypassList: z.array(z.string().min(1).max(253)).max(100),
    proxyAuthentication: ProxyAuthenticationSchema.optional(),
    caCertificatePaths: z.array(AbsoluteFilePathSchema).max(20),
    requireCertificateVerification: z.literal(true),
    minimumTlsVersion: z.enum(['TLSv1.2', 'TLSv1.3']),
    directProtocols: z.array(z.enum(['git-ssh', 'kafka', 'mqtt'])).max(3),
  })
  .strict()
  .superRefine((network, ctx) => {
    if (network.mode === 'fixed' && !network.proxyUrl) {
      ctx.addIssue({ code: 'custom', path: ['proxyUrl'], message: 'Fixed mode requires proxyUrl' });
    }
    if (network.mode === 'pac' && !network.pacUrl) {
      ctx.addIssue({ code: 'custom', path: ['pacUrl'], message: 'PAC mode requires pacUrl' });
    }
    if (network.mode === 'direct' && network.requireProxy) {
      ctx.addIssue({
        code: 'custom',
        path: ['requireProxy'],
        message: 'Direct mode cannot require a proxy',
      });
    }
  });

const ManagedUpdatesPolicySchema = z
  .object({
    mode: z.enum(['disabled', 'notify', 'auto-download', 'install-on-quit']),
    channel: z.enum(['stable', 'beta']),
    feedUrl: HttpsUrlSchema.optional(),
    requestHeaderEnv: z
      .record(z.string().regex(UPDATE_HEADER), z.string().regex(ENV_NAME))
      .refine((headers) => Object.keys(headers).length <= 20, 'Too many update headers'),
  })
  .strict()
  .superRefine((updates, ctx) => {
    if (updates.mode !== 'disabled' && !updates.feedUrl) {
      ctx.addIssue({
        code: 'custom',
        path: ['feedUrl'],
        message: 'Enabled managed updates require feedUrl',
      });
    }
  });

export const EnterprisePolicyV1Schema = z
  .object({
    version: z.literal(1),
    network: ManagedNetworkPolicySchema,
    updates: ManagedUpdatesPolicySchema,
  })
  .strict();

export type EnterprisePolicyV1 = z.infer<typeof EnterprisePolicyV1Schema>;
export type ManagedPolicySource = 'native' | 'environment-file' | 'machine-file';
export type ManagedDirectProtocol = EnterprisePolicyV1['network']['directProtocols'][number];

export type ManagedPolicyStatus =
  | { state: 'unmanaged' }
  | {
      state: 'managed';
      source: ManagedPolicySource;
      networkMode: EnterprisePolicyV1['network']['mode'];
      updatesMode: EnterprisePolicyV1['updates']['mode'];
      requireProxy: boolean;
    }
  | { state: 'invalid'; source: ManagedPolicySource; message: string };

export type ManagedPolicyLoadResult = {
  status: ManagedPolicyStatus;
  policy?: EnterprisePolicyV1;
};

type FileStat = {
  uid?: number;
  mode: number;
  size: number;
  dev?: number;
  ino?: number;
  isFile?: boolean;
  isSymbolicLink?: boolean;
};

class PolicyTrustError extends Error {}

export interface ManagedPolicyLoadOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  readNativePolicy?: (platform: NodeJS.Platform) => string | undefined;
  readFile?: (filePath: string) => string;
  statFile?: (filePath: string) => FileStat;
  isWindowsFileTrusted?: (filePath: string) => boolean;
}

export interface ManagedCaLoadOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  readFile?: (filePath: string) => string;
  statFile?: (filePath: string) => FileStat;
  isWindowsFileTrusted?: (filePath: string) => boolean;
}

function readNativePolicy(platform: NodeJS.Platform): string | undefined {
  try {
    if (platform === 'win32') {
      const output = execFileSync(
        'reg.exe',
        ['query', 'HKLM\\Software\\Policies\\Restura', '/v', 'EnterprisePolicy'],
        { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
      );
      return output.match(/EnterprisePolicy\s+REG_(?:SZ|EXPAND_SZ)\s+(.+)$/m)?.[1]?.trim();
    }
    if (platform === 'darwin') {
      return execFileSync(
        '/usr/bin/defaults',
        ['read', '/Library/Managed Preferences/com.dipjyotimetia.restura', 'EnterprisePolicy'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      ).trim();
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function machinePolicyPath(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  if (platform === 'win32') {
    return path.join(env.ProgramData ?? 'C:\\ProgramData', 'Restura', 'policy.json');
  }
  if (platform === 'darwin') {
    return '/Library/Application Support/Restura/policy.json';
  }
  return '/etc/restura/policy.json';
}

function isWindowsFileAdminControlled(filePath: string): boolean {
  const script = [
    '$acl = Get-Acl -LiteralPath $args[0]',
    '$ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value',
    "if (@('S-1-5-18', 'S-1-5-32-544') -notcontains $ownerSid) { exit 2 }",
    "$unsafe = $acl.Access | Where-Object { $sid = $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value; $_.AccessControlType -eq 'Allow' -and @('S-1-5-18', 'S-1-5-32-544') -notcontains $sid -and $_.FileSystemRights.ToString() -match 'Write|Modify|FullControl|Create|Delete|TakeOwnership|ChangePermissions' }",
    'if ($unsafe) { exit 3 }',
  ].join('; ');
  try {
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script, filePath],
      { windowsHide: true, stdio: 'ignore' }
    );
    return true;
  } catch {
    return false;
  }
}

function validateTrustedFile(
  platform: NodeJS.Platform,
  filePath: string,
  stat: FileStat,
  isWindowsFileTrusted: (filePath: string) => boolean,
  env: NodeJS.ProcessEnv
): void {
  if (stat.isSymbolicLink || stat.isFile === false) {
    throw new PolicyTrustError('Policy must be a protected regular file');
  }
  if (stat.size > MAX_POLICY_BYTES) {
    throw new PolicyTrustError('Policy exceeds the 256 KiB size limit');
  }
  if (platform === 'win32') {
    const programData = path.win32.resolve(env.ProgramData ?? 'C:\\ProgramData');
    if (
      !path.win32
        .resolve(filePath)
        .toLowerCase()
        .startsWith(`${programData.toLowerCase()}${path.win32.sep}`)
    ) {
      throw new PolicyTrustError('Windows policy files must be stored under ProgramData');
    }
    if (!isWindowsFileTrusted(filePath)) {
      throw new PolicyTrustError(
        'Windows policy file must be owned and writable only by administrators'
      );
    }
    return;
  }
  if (stat.uid !== 0) throw new PolicyTrustError('Policy file must be administrator-owned');
  if ((stat.mode & 0o022) !== 0) {
    throw new PolicyTrustError('Policy file must not be group or world writable');
  }
}

function readProtectedPolicyFile(
  filePath: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  isWindowsFileTrusted: (filePath: string) => boolean
): string {
  const before = lstatSync(filePath);
  const beforeStat: FileStat = {
    uid: before.uid,
    mode: before.mode,
    size: before.size,
    dev: before.dev,
    ino: before.ino,
    isFile: before.isFile(),
    isSymbolicLink: before.isSymbolicLink(),
  };
  validateTrustedFile(platform, filePath, beforeStat, isWindowsFileTrusted, env);

  const flags = constants.O_RDONLY | (platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0));
  const descriptor = openSync(filePath, flags);
  try {
    const after = fstatSync(descriptor);
    validateTrustedFile(
      platform,
      filePath,
      {
        uid: after.uid,
        mode: after.mode,
        size: after.size,
        dev: after.dev,
        ino: after.ino,
        isFile: after.isFile(),
        isSymbolicLink: false,
      },
      isWindowsFileTrusted,
      env
    );
    if (before.dev !== after.dev || before.ino !== after.ino) {
      throw new PolicyTrustError('Policy changed while it was being loaded');
    }
    return readFileSync(descriptor, 'utf8');
  } finally {
    closeSync(descriptor);
  }
}

function parseSelectedSource(raw: string, source: ManagedPolicySource): ManagedPolicyLoadResult {
  if (Buffer.byteLength(raw, 'utf8') > MAX_POLICY_BYTES) {
    return {
      status: { state: 'invalid', source, message: 'Policy exceeds the 256 KiB size limit' },
    };
  }
  try {
    const policy = EnterprisePolicyV1Schema.parse(JSON.parse(raw));
    return {
      policy,
      status: {
        state: 'managed',
        source,
        networkMode: policy.network.mode,
        updatesMode: policy.updates.mode,
        requireProxy: policy.network.requireProxy,
      },
    };
  } catch {
    return {
      status: {
        state: 'invalid',
        source,
        message: 'Policy does not match the strict EnterprisePolicyV1 schema',
      },
    };
  }
}

function loadPolicyFile(
  filePath: string,
  source: ManagedPolicySource,
  platform: NodeJS.Platform,
  readFile: (filePath: string) => string,
  statFile: (filePath: string) => FileStat,
  isWindowsFileTrusted: (filePath: string) => boolean,
  env: NodeJS.ProcessEnv
): ManagedPolicyLoadResult | undefined {
  try {
    const stat = statFile(filePath);
    validateTrustedFile(platform, filePath, stat, isWindowsFileTrusted, env);
    return parseSelectedSource(readFile(filePath), source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return {
      status: {
        state: 'invalid',
        source,
        message:
          error instanceof PolicyTrustError
            ? error.message
            : 'Policy file could not be read or trusted',
      },
    };
  }
}

export function loadManagedEnterprisePolicy(
  options: ManagedPolicyLoadOptions = {}
): ManagedPolicyLoadResult {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const native = (options.readNativePolicy ?? readNativePolicy)(platform);
  if (native !== undefined) return parseSelectedSource(native, 'native');

  const isWindowsFileTrusted = options.isWindowsFileTrusted ?? isWindowsFileAdminControlled;
  const readFile =
    options.readFile ??
    ((filePath) => readProtectedPolicyFile(filePath, platform, env, isWindowsFileTrusted));
  const statFile =
    options.statFile ??
    ((filePath) => {
      const stat = statSync(filePath);
      return {
        uid: stat.uid,
        mode: stat.mode,
        size: stat.size,
        isFile: stat.isFile(),
        isSymbolicLink: stat.isSymbolicLink(),
      };
    });
  const selectedFile = env.RESTURA_ENTERPRISE_POLICY_FILE;

  if (selectedFile) {
    return (
      loadPolicyFile(
        selectedFile,
        'environment-file',
        platform,
        readFile,
        statFile,
        isWindowsFileTrusted,
        env
      ) ?? {
        status: {
          state: 'invalid',
          source: 'environment-file',
          message: 'Selected policy file does not exist',
        },
      }
    );
  }

  return (
    loadPolicyFile(
      machinePolicyPath(platform, env),
      'machine-file',
      platform,
      readFile,
      statFile,
      isWindowsFileTrusted,
      env
    ) ?? { status: { state: 'unmanaged' } }
  );
}

export function assertManagedOutboundAllowed(result: ManagedPolicyLoadResult): void {
  if (result.status.state === 'invalid') {
    throw new Error(`Managed enterprise policy is invalid: ${result.status.message}`);
  }
}

let activeManagedPolicy = loadManagedEnterprisePolicy();
let activeCaBundle: string | undefined;

export function getManagedEnterprisePolicy(): ManagedPolicyLoadResult {
  return activeManagedPolicy.policy
    ? {
        policy: EnterprisePolicyV1Schema.parse(activeManagedPolicy.policy),
        status: { ...activeManagedPolicy.status },
      }
    : { status: { ...activeManagedPolicy.status } };
}

export function setManagedEnterprisePolicyForTest(result: ManagedPolicyLoadResult): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Managed enterprise policy can only be replaced by tests');
  }
  activeManagedPolicy = result.policy
    ? { policy: EnterprisePolicyV1Schema.parse(result.policy), status: { ...result.status } }
    : { status: { ...result.status } };
  activeCaBundle = undefined;
}

export function markManagedPolicyRuntimeInvalid(_message: string): void {
  if (activeManagedPolicy.status.state !== 'managed') return;
  activeManagedPolicy = {
    status: {
      state: 'invalid',
      source: activeManagedPolicy.status.source,
      message: 'Managed enterprise policy could not be applied. Contact your administrator.',
    },
  };
  activeCaBundle = undefined;
}

function validateTrustedCaFile(
  platform: NodeJS.Platform,
  filePath: string,
  stat: FileStat,
  isWindowsFileTrusted: (filePath: string) => boolean,
  env: NodeJS.ProcessEnv
): void {
  if (stat.isSymbolicLink || stat.isFile === false) {
    throw new PolicyTrustError('Managed CA certificate must be a protected regular file');
  }
  if (stat.size > MAX_CA_BUNDLE_BYTES) {
    throw new PolicyTrustError('Managed CA certificate exceeds the 2 MiB size limit');
  }
  if (platform === 'win32') {
    const programData = path.win32.resolve(env.ProgramData ?? 'C:\\ProgramData');
    const resolved = path.win32.resolve(filePath);
    if (!resolved.toLowerCase().startsWith(`${programData.toLowerCase()}${path.win32.sep}`)) {
      throw new PolicyTrustError(
        'Windows managed CA certificates must be stored under ProgramData'
      );
    }
    if (!isWindowsFileTrusted(filePath)) {
      throw new PolicyTrustError(
        'Windows managed CA certificate must be owned and writable only by administrators'
      );
    }
    return;
  }
  if (stat.uid !== 0) {
    throw new PolicyTrustError('Managed CA certificate must be administrator-owned');
  }
  if ((stat.mode & 0o022) !== 0) {
    throw new PolicyTrustError('Managed CA certificate must not be group or world writable');
  }
}

function readProtectedCaFile(
  filePath: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  isWindowsFileTrusted: (filePath: string) => boolean
): string {
  const before = lstatSync(filePath);
  const beforeStat: FileStat = {
    uid: before.uid,
    mode: before.mode,
    size: before.size,
    dev: before.dev,
    ino: before.ino,
    isFile: before.isFile(),
    isSymbolicLink: before.isSymbolicLink(),
  };
  validateTrustedCaFile(platform, filePath, beforeStat, isWindowsFileTrusted, env);

  const flags = constants.O_RDONLY | (platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0));
  const descriptor = openSync(filePath, flags);
  try {
    const after = fstatSync(descriptor);
    const afterStat: FileStat = {
      uid: after.uid,
      mode: after.mode,
      size: after.size,
      dev: after.dev,
      ino: after.ino,
      isFile: after.isFile(),
      isSymbolicLink: false,
    };
    validateTrustedCaFile(platform, filePath, afterStat, isWindowsFileTrusted, env);
    if (before.dev !== after.dev || before.ino !== after.ino) {
      throw new PolicyTrustError('Managed CA certificate changed while it was being loaded');
    }
    return readFileSync(descriptor, 'utf8');
  } finally {
    closeSync(descriptor);
  }
}

function parseManagedCaCertificates(bundle: string): string {
  const blocks =
    bundle.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  if (blocks.length === 0) {
    throw new Error('Managed CA bundle does not contain a valid X.509 certificate');
  }

  const now = Date.now();
  const unique = new Map<string, string>();
  try {
    for (const block of blocks) {
      const certificate = new X509Certificate(block);
      if (Date.parse(certificate.validFrom) > now || Date.parse(certificate.validTo) < now) {
        throw new Error('Managed CA bundle contains an expired or not-yet-valid certificate');
      }
      unique.set(certificate.fingerprint256, block);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Managed CA bundle')) throw error;
    throw new Error('Managed CA bundle does not contain a valid X.509 certificate');
  }
  return [...unique.values()].join('\n');
}

export function getManagedCaCertificateBundle(
  options: ManagedCaLoadOptions = {}
): string | undefined {
  if (activeCaBundle !== undefined) return activeCaBundle || undefined;
  if (activeManagedPolicy.status.state !== 'managed' || !activeManagedPolicy.policy) {
    return undefined;
  }
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const isWindowsFileTrusted = options.isWindowsFileTrusted ?? isWindowsFileAdminControlled;
  const readFile = options.readFile;
  const statFile = options.statFile;
  const bundle = activeManagedPolicy.policy.network.caCertificatePaths
    .map((filePath) => {
      if (!readFile) {
        return readProtectedCaFile(filePath, platform, env, isWindowsFileTrusted);
      }
      const stat =
        statFile?.(filePath) ??
        (() => {
          const value = lstatSync(filePath);
          return {
            uid: value.uid,
            mode: value.mode,
            size: value.size,
            isFile: value.isFile(),
            isSymbolicLink: value.isSymbolicLink(),
          };
        })();
      validateTrustedCaFile(platform, filePath, stat, isWindowsFileTrusted, env);
      return readFile(filePath);
    })
    .join('\n');
  if (Buffer.byteLength(bundle, 'utf8') > MAX_CA_BUNDLE_BYTES) {
    throw new Error('Managed CA certificate bundle exceeds the 2 MiB size limit');
  }
  activeCaBundle = bundle ? parseManagedCaCertificates(bundle) : '';
  return activeCaBundle || undefined;
}

export function assertManagedDirectProtocolAllowed(protocol: ManagedDirectProtocol): void {
  assertManagedOutboundAllowed(activeManagedPolicy);
  if (
    activeManagedPolicy.status.state === 'managed' &&
    activeManagedPolicy.policy?.network.requireProxy &&
    !activeManagedPolicy.policy.network.directProtocols.includes(protocol)
  ) {
    const label = protocol === 'git-ssh' ? 'Git SSH' : protocol === 'kafka' ? 'Kafka' : 'MQTT';
    throw new Error(`Managed policy blocks direct ${label} connections while a proxy is required`);
  }
}

export function managedDirectProtocolError(protocol: ManagedDirectProtocol): string | undefined {
  try {
    assertManagedDirectProtocolAllowed(protocol);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
