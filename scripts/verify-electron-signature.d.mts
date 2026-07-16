export interface SignaturePolicy {
  requireDeveloperId?: boolean;
  expectedTeamIdentifier?: string;
  expectedBundleIdentifier?: string;
}

export interface CommandResult {
  stdout?: string;
  stderr?: string;
}

export type SignatureCommandExecutor = (command: string, args: string[]) => Promise<CommandResult>;

export type SignatureVerificationResult =
  | { status: 'verified' }
  | { status: 'skipped'; reason: string };

export function parseCliPolicy(args: string[]): {
  appPath: string;
  policy: SignaturePolicy;
};

export function verifySignedMacApp(
  appPath: string,
  policy?: SignaturePolicy,
  execute?: SignatureCommandExecutor
): Promise<SignatureVerificationResult>;

export function afterSign(context: {
  electronPlatformName: string;
  appOutDir?: string;
  packager?: {
    appInfo: {
      productFilename: string;
      macBundleIdentifier: string;
    };
  };
}): Promise<void>;

export default afterSign;
