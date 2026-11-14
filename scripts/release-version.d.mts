export function nextVersion(current: string, bump: string, prereleaseIdentifier?: string): string;

export function isVersionOnlyDiff(diff: string, version: string): boolean;

export function unpublishedStableAhead(
  current: string,
  published: readonly string[]
): { current: string; latest: string } | null;

export function formatUnpublishedGuard(ahead: { current: string; latest: string }): string;

export function formatTagRulesetRejection(tag: string, action: 'create' | 'delete'): string;

export function formatExistingRelease(tag: string): string;

export function runCli(
  argv: string[],
  io: { read: (file: string | number) => string; log: (line: string) => void }
): number;
