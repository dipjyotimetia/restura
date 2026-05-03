import type { HttpRequest, RequestSettings } from '@/types';

export interface GenerateOptions {
  request: HttpRequest;
  resolvedUrl: string;
  resolvedHeaders: Record<string, string>;
  resolvedParams: Record<string, string>;
  settings?: RequestSettings;
}

export const escapeShell = (str: string): string => `'${str.replace(/'/g, "'\\''")}'`;

export const escapeJson = (str: string): string =>
  str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
