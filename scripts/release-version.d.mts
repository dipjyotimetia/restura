export function nextVersion(current: string, bump: string, prereleaseIdentifier?: string): string;

export function isVersionOnlyDiff(diff: string, version: string): boolean;

export function runCli(
  argv: string[],
  io: { read: (file: string | number) => string; log: (line: string) => void }
): number;
