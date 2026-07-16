/** Generate a sampled W3C traceparent value without depending on a UI runtime. */
export function generateTraceparent(): string {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
      hex += bytes[i]!.toString(16).padStart(2, '0');
    }
    return `00-${hex.substring(0, 32)}-${hex.substring(32, 48)}-01`;
  }

  const randomHex = (length: number): string => {
    let result = '';
    for (let i = 0; i < length; i++) {
      result += Math.floor(Math.random() * 16).toString(16);
    }
    return result;
  };

  return `00-${randomHex(32)}-${randomHex(16)}-01`;
}
