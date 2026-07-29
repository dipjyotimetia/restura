import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const MAX_POLICY_BYTES = 256 * 1024;
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

const ManagedNetworkPolicySchema = z
  .object({
    mode: z.enum(['system', 'fixed', 'pac', 'direct']),
    requireProxy: z.boolean(),
    proxyUrl: ProxyUrlSchema.optional(),
    pacUrl: HttpsUrlSchema.optional(),
    bypassList: z.array(z.string().min(1).max(253)).max(100),
    usernameEnv: z.string().regex(ENV_NAME).optional(),
    passwordEnv: z.string().regex(ENV_NAME).optional(),
    caCertificatePaths: z.array(z.string().min(1).max(4096)).max(20),
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
    if ((network.usernameEnv === undefined) !== (network.passwordEnv === undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['usernameEnv'],
        message: 'Proxy username and password environment references must be configured together',
      });
    }
    if (network.usernameEnv && network.mode !== 'fixed') {
      ctx.addIssue({
        code: 'custom',
        path: ['usernameEnv'],
        message: 'Proxy credential environment references require fixed proxy mode',
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
    minimumVersion: z
      .string()
      .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
      .optional(),
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
    telemetry: z
      .object({
        errorReporting: z.boolean(),
        agentTelemetry: z.boolean(),
      })
      .strict(),
    ai: z
      .object({
        enabled: z.boolean(),
        providers: z
          .array(z.enum(['openai', 'anthropic', 'google', 'ollama', 'openai-compatible']))
          .max(5),
        baseOrigins: z.array(HttpsUrlSchema).max(50),
      })
      .strict(),
    features: z
      .object({
        git: z.boolean(),
        gitSsh: z.boolean(),
        mcp: z.boolean(),
        importExport: z.boolean(),
        mockCapture: z.boolean(),
        kafka: z.boolean(),
        mqtt: z.boolean(),
      })
      .strict(),
  })
  .strict();

export type EnterprisePolicyV1 = z.infer<typeof EnterprisePolicyV1Schema>;
export type ManagedPolicySource = 'native' | 'environment-file' | 'machine-file';

export type ManagedPolicyStatus =
  | { state: 'unmanaged' }
  | {
      state: 'managed';
      source: ManagedPolicySource;
      networkMode: EnterprisePolicyV1['network']['mode'];
      updatesMode: EnterprisePolicyV1['updates']['mode'];
      requireProxy: boolean;
      minimumVersion?: string;
      upgradeRequired?: boolean;
    }
  | { state: 'invalid'; source: ManagedPolicySource; message: string };

export type ManagedPolicyLoadResult = {
  status: ManagedPolicyStatus;
  policy?: EnterprisePolicyV1;
};

type FileStat = { uid?: number; mode: number; size: number };

export interface ManagedPolicyLoadOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  readNativePolicy?: (platform: NodeJS.Platform) => string | undefined;
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
    "if ($acl.Owner -notmatch '(?i)(^|\\\\)(Administrators|SYSTEM)$') { exit 2 }",
    "$unsafe = $acl.Access | Where-Object { $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -match '(?i)(^|\\\\)(Users|Authenticated Users|Everyone)$' -and $_.FileSystemRights.ToString() -match 'Write|Modify|FullControl|Create|Delete|TakeOwnership|ChangePermissions' }",
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
  if (stat.size > MAX_POLICY_BYTES) {
    throw new Error('Policy exceeds the 256 KiB size limit');
  }
  if (platform === 'win32') {
    const programData = path.win32.resolve(env.ProgramData ?? 'C:\\ProgramData');
    if (
      !path.win32
        .resolve(filePath)
        .toLowerCase()
        .startsWith(`${programData.toLowerCase()}${path.win32.sep}`)
    ) {
      throw new Error('Windows policy files must be stored under ProgramData');
    }
    if (!isWindowsFileTrusted(filePath)) {
      throw new Error('Windows policy file must be owned and writable only by administrators');
    }
    return;
  }
  if (stat.uid !== 0) {
    throw new Error('Policy file must be administrator-owned');
  }
  if ((stat.mode & 0o022) !== 0) {
    throw new Error('Policy file must not be group or world writable');
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
        ...(policy.updates.minimumVersion ? { minimumVersion: policy.updates.minimumVersion } : {}),
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
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    return {
      status: {
        state: 'invalid',
        source,
        message: error instanceof Error ? error.message : 'Policy file could not be read',
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

  const readFile = options.readFile ?? ((filePath) => readFileSync(filePath, 'utf8'));
  const statFile =
    options.statFile ??
    ((filePath) => {
      const stat = statSync(filePath);
      return { uid: stat.uid, mode: stat.mode, size: stat.size };
    });
  const isWindowsFileTrusted = options.isWindowsFileTrusted ?? isWindowsFileAdminControlled;

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

/** Test seam for proving enforcement without mutating process-wide policy sources. */
export function setManagedEnterprisePolicyForTest(result: ManagedPolicyLoadResult): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('Managed enterprise policy can only be replaced by tests');
  }
  activeManagedPolicy = result.policy
    ? { policy: EnterprisePolicyV1Schema.parse(result.policy), status: { ...result.status } }
    : { status: { ...result.status } };
  activeCaBundle = undefined;
}

export function assertActiveManagedOutboundAllowed(): void {
  assertManagedOutboundAllowed(activeManagedPolicy);
  if (
    activeManagedPolicy.status.state === 'managed' &&
    activeManagedPolicy.status.upgradeRequired
  ) {
    throw new Error(
      `Restura ${activeManagedPolicy.status.minimumVersion} is the minimum required version`
    );
  }
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

function parsedVersion(version: string): {
  core: [number, number, number];
  prerelease: string[] | undefined;
} {
  const [core = '0.0.0', prerelease] = version.split('-', 2);
  const [major = '0', minor = '0', patch = '0'] = core.split('.');
  return {
    core: [Number(major), Number(minor), Number(patch)],
    prerelease: prerelease?.split('.'),
  };
}

function versionIsBelow(current: string, minimum: string): boolean {
  const left = parsedVersion(current);
  const right = parsedVersion(minimum);
  for (let index = 0; index < left.core.length; index += 1) {
    if (left.core[index]! < right.core[index]!) return true;
    if (left.core[index]! > right.core[index]!) return false;
  }
  if (!left.prerelease) return false;
  if (!right.prerelease) return true;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const currentId = left.prerelease[index];
    const minimumId = right.prerelease[index];
    if (currentId === undefined) return true;
    if (minimumId === undefined) return false;
    if (currentId === minimumId) continue;
    const currentNumber = /^\d+$/.test(currentId) ? Number(currentId) : undefined;
    const minimumNumber = /^\d+$/.test(minimumId) ? Number(minimumId) : undefined;
    if (currentNumber !== undefined && minimumNumber !== undefined) {
      return currentNumber < minimumNumber;
    }
    if (currentNumber !== undefined) return true;
    if (minimumNumber !== undefined) return false;
    return currentId < minimumId;
  }
  return false;
}

export function setManagedAppVersion(currentVersion: string): void {
  if (activeManagedPolicy.status.state !== 'managed') return;
  const minimumVersion = activeManagedPolicy.policy?.updates.minimumVersion;
  activeManagedPolicy.status = {
    ...activeManagedPolicy.status,
    ...(minimumVersion
      ? {
          minimumVersion,
          upgradeRequired: versionIsBelow(currentVersion, minimumVersion),
        }
      : {}),
  };
}

export function getManagedCaCertificateBundle(
  readFile: (filePath: string) => string = (filePath) => readFileSync(filePath, 'utf8')
): string | undefined {
  if (activeCaBundle !== undefined) return activeCaBundle || undefined;
  if (activeManagedPolicy.status.state !== 'managed' || !activeManagedPolicy.policy) {
    return undefined;
  }
  const certificates = activeManagedPolicy.policy.network.caCertificatePaths.map(readFile);
  const bundle = certificates.join('\n');
  if (Buffer.byteLength(bundle, 'utf8') > 2 * 1024 * 1024) {
    throw new Error('Managed CA certificate bundle exceeds the 2 MiB size limit');
  }
  activeCaBundle = bundle;
  return bundle || undefined;
}

export type ManagedFeature = keyof EnterprisePolicyV1['features'];
export type ManagedDirectProtocol = EnterprisePolicyV1['network']['directProtocols'][number];

export function assertManagedFeatureAllowed(feature: ManagedFeature): void {
  assertActiveManagedOutboundAllowed();
  if (
    activeManagedPolicy.status.state === 'managed' &&
    activeManagedPolicy.policy?.features[feature] !== true
  ) {
    throw new Error(`${feature} is disabled by managed policy`);
  }
}

export function assertManagedDirectProtocolAllowed(protocol: ManagedDirectProtocol): void {
  assertActiveManagedOutboundAllowed();
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
    assertManagedFeatureAllowed(protocol === 'git-ssh' ? 'gitSsh' : protocol);
    assertManagedDirectProtocolAllowed(protocol);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function assertManagedAiAllowed(provider: string, baseUrl: string): void {
  assertActiveManagedOutboundAllowed();
  if (activeManagedPolicy.status.state !== 'managed' || !activeManagedPolicy.policy) return;
  const ai = activeManagedPolicy.policy.ai;
  if (!ai.enabled) throw new Error('AI is disabled by managed policy');
  if (!ai.providers.includes(provider as (typeof ai.providers)[number])) {
    throw new Error(`AI provider "${provider}" is disabled by managed policy`);
  }
  const origin = new URL(baseUrl).origin;
  if (!ai.baseOrigins.some((allowed) => new URL(allowed).origin === origin)) {
    throw new Error(`AI base origin "${origin}" is not allowed by managed policy`);
  }
}

export function isManagedTelemetryAllowed(kind: 'errorReporting' | 'agentTelemetry'): boolean {
  const result = getManagedEnterprisePolicy();
  if (result.status.state === 'invalid') return false;
  if (result.status.state === 'unmanaged') return true;
  return result.policy?.telemetry[kind] === true;
}

export function assertManagedAgentTelemetryAllowed(): void {
  if (!isManagedTelemetryAllowed('agentTelemetry')) {
    throw new Error('Agent telemetry export is disabled by enterprise policy');
  }
}
