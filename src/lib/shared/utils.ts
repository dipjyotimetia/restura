import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 Bytes';

  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

export function formatTime(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleString();
}

/**
 * Convert an array of KeyValue items into a plain Record, dropping disabled or
 * blank-key entries. Used by every protocol that builds a header/param map for
 * a network call.
 */
export function keyValuePairsToRecord(
  items: ReadonlyArray<{ key: string; value: string; enabled: boolean }>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const it of items) {
    if (it.enabled && it.key.trim()) out[it.key.trim()] = it.value;
  }
  return out;
}

export function debounce<T extends (...args: never[]) => unknown>(
  func: T,
  wait: number
): (...args: Parameters<T>) => void {
  let timeout: NodeJS.Timeout | null = null;

  return (...args: Parameters<T>) => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  };
}

export function generateTraceparent(): string {
  // W3C Trace Context format: 00-{trace-id}-{parent-id}-{trace-flags}
  // trace-id: 32 hex chars (16 bytes)
  // parent-id: 16 hex chars (8 bytes)
  // trace-flags: 01 for sampled

  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    let hex = '';
    for (let i = 0; i < 24; i++) {
      hex += bytes[i]!.toString(16).padStart(2, '0');
    }
    const traceId = hex.substring(0, 32);
    const spanId = hex.substring(32, 48);
    return `00-${traceId}-${spanId}-01`;
  }

  // Fallback if Web Crypto API is unavailable
  const randomHex = (len: number) => {
    let result = '';
    for (let i = 0; i < len; i++) {
      result += Math.floor(Math.random() * 16).toString(16);
    }
    return result;
  };

  return `00-${randomHex(32)}-${randomHex(16)}-01`;
}
