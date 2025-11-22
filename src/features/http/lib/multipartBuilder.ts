import { MultipartPart } from '@/types';

// Generate a random boundary string
export function generateBoundary(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let boundary = '----Boundary';
  for (let i = 0; i < 16; i++) {
    boundary += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return boundary;
}

// Build multipart/mixed body from parts
export function buildMultipartMixedBody(
  parts: MultipartPart[],
  boundary: string
): string {
  if (parts.length === 0) {
    return '';
  }

  const lines: string[] = [];

  for (const part of parts) {
    // Boundary delimiter
    lines.push(`--${boundary}`);

    // Content-Type header
    lines.push(`Content-Type: ${part.contentType}`);

    // Additional headers
    if (part.headers) {
      for (const [key, value] of Object.entries(part.headers)) {
        if (key.toLowerCase() !== 'content-type') {
          lines.push(`${key}: ${value}`);
        }
      }
    }

    // Empty line separating headers from content
    lines.push('');

    // Part content
    lines.push(part.content);
  }

  // Closing boundary
  lines.push(`--${boundary}--`);

  return lines.join('\r\n');
}

// Parse multipart/mixed response body
export function parseMultipartMixedBody(
  body: string,
  boundary: string
): MultipartPart[] {
  const parts: MultipartPart[] = [];
  const partDelimiter = `--${boundary}`;

  // Split by boundary
  const segments = body.split(partDelimiter);

  for (let i = 1; i < segments.length; i++) {
    const segment = segments[i];
    if (!segment || segment.trim() === '--' || segment.startsWith('--')) {
      continue;
    }

    // Split headers and content by empty line
    const emptyLineIndex = segment.indexOf('\r\n\r\n');
    if (emptyLineIndex === -1) {
      continue;
    }

    const headerSection = segment.substring(0, emptyLineIndex);
    let content = segment.substring(emptyLineIndex + 4);

    // Remove trailing CRLF
    if (content.endsWith('\r\n')) {
      content = content.slice(0, -2);
    }

    // Parse headers
    const headers: Record<string, string> = {};
    let contentType = 'application/octet-stream';

    const headerLines = headerSection.split('\r\n');
    for (const line of headerLines) {
      const colonIndex = line.indexOf(':');
      if (colonIndex > 0) {
        const key = line.substring(0, colonIndex).trim();
        const value = line.substring(colonIndex + 1).trim();
        headers[key] = value;

        if (key.toLowerCase() === 'content-type') {
          contentType = value;
        }
      }
    }

    parts.push({
      id: `part-${Date.now()}-${i}`,
      contentType,
      content,
      headers,
    });
  }

  return parts;
}

// Validate multipart parts
export function validateMultipartParts(
  parts: MultipartPart[]
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (parts.length === 0) {
    errors.push('At least one part is required');
  }

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;

    if (!part.contentType) {
      errors.push(`Part ${i + 1}: Content-Type is required`);
    }

    if (part.content === undefined || part.content === null) {
      errors.push(`Part ${i + 1}: Content is required`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// Get default content type suggestions
export function getContentTypeSuggestions(): string[] {
  return [
    'application/json',
    'application/xml',
    'text/plain',
    'text/html',
    'text/csv',
    'application/octet-stream',
    'image/png',
    'image/jpeg',
    'application/pdf',
  ];
}
