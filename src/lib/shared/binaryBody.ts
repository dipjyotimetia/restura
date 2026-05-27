/**
 * Renderer-side helpers for `Response.bodyEncoding === 'base64'` bodies.
 * The proxy base64-encodes binary responses (see shared/protocol/binary.ts);
 * the renderer decodes here to build Blobs for download or preview.
 */

/** Decode a base64 string to raw bytes. Tolerates an accidental data: prefix. */
export function base64ToBytes(base64: string): Uint8Array {
  const cleaned = base64.includes(',') ? base64.slice(base64.indexOf(',') + 1) : base64;
  const binary = atob(cleaned);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** A reasonable file extension for a binary content type, for download naming. */
export function extensionForContentType(contentType: string): string {
  const essence = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/avif': 'avif',
    'image/bmp': 'bmp',
    'image/x-icon': 'ico',
    'application/pdf': 'pdf',
    'application/zip': 'zip',
    'application/gzip': 'gz',
    'audio/mpeg': 'mp3',
    'video/mp4': 'mp4',
    'font/woff2': 'woff2',
  };
  if (map[essence]) return map[essence];
  const slash = essence.indexOf('/');
  const sub = slash >= 0 ? essence.slice(slash + 1) : '';
  return sub.replace(/[^a-z0-9]+/g, '') || 'bin';
}
