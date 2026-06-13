// Renderer-side size-display helpers for the base64 bytes stored on form-data
// file fields + binary bodies (encoded at pick time via `readFileAsBase64` from
// `@/lib/shared/file-utils` so they survive Dexie persistence and the IPC
// boundary — a File object would not).

/** Decoded byte length of a base64 string (for size display). */
export function base64ByteLength(b64: string): number {
  if (!b64) return 0;
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
