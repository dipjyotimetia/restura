import { VariableExtraction, Response } from '@/types';

/**
 * Safely parse JSON body, returning null on failure
 */
export function parseJsonSafely(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/**
 * Extract value using dot notation path (e.g., "data.user.id")
 * Supports array indexing (e.g., "data.users[0].name")
 */
export function extractByJsonPath(body: string, path: string): string | undefined {
  const parsed = parseJsonSafely(body);
  if (parsed === null) return undefined;

  const parts = path.split(/\.|\[|\]/).filter(Boolean);
  let current: unknown = parsed;

  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;

    const index = parseInt(part, 10);
    if (!isNaN(index) && Array.isArray(current)) {
      current = current[index];
    } else {
      current = (current as Record<string, unknown>)[part];
    }
  }

  if (current === null || current === undefined) return undefined;

  // Convert to string for storage
  if (typeof current === 'object') {
    return JSON.stringify(current);
  }
  return String(current);
}

/**
 * Extract value using regex pattern with capture group
 * Returns the first capture group or the full match
 */
export function extractByRegex(body: string, pattern: string): string | undefined {
  try {
    const regex = new RegExp(pattern);
    const match = regex.exec(body);
    if (!match) return undefined;

    // Return first capture group if available, otherwise full match
    return match[1] ?? match[0];
  } catch {
    return undefined;
  }
}

/**
 * Extract value from response headers
 */
export function extractByHeader(
  headers: Record<string, string | string[]>,
  headerName: string
): string | undefined {
  // Case-insensitive header lookup
  const lowerName = headerName.toLowerCase();
  const key = Object.keys(headers).find((k) => k.toLowerCase() === lowerName);

  if (!key) return undefined;

  const value = headers[key];
  return Array.isArray(value) ? value.join(', ') : value;
}

/**
 * Extract variables from response based on extraction rules
 */
export function extractVariables(
  response: Response,
  extractions: VariableExtraction[]
): Record<string, string> {
  const result: Record<string, string> = {};

  for (const extraction of extractions) {
    let value: string | undefined;

    switch (extraction.extractionMethod) {
      case 'jsonpath':
        value = extractByJsonPath(response.body, extraction.path);
        break;
      case 'regex':
        value = extractByRegex(response.body, extraction.path);
        break;
      case 'header':
        value = extractByHeader(response.headers, extraction.path);
        break;
    }

    if (value !== undefined) {
      result[extraction.variableName] = value;
    }
  }

  return result;
}

/**
 * Test extraction against a response body (for preview in UI)
 */
export function testExtraction(
  body: string,
  headers: Record<string, string | string[]>,
  extraction: VariableExtraction
): { success: boolean; value?: string; error?: string } {
  try {
    let value: string | undefined;

    switch (extraction.extractionMethod) {
      case 'jsonpath':
        value = extractByJsonPath(body, extraction.path);
        break;
      case 'regex':
        value = extractByRegex(body, extraction.path);
        break;
      case 'header':
        value = extractByHeader(headers, extraction.path);
        break;
    }

    if (value !== undefined) {
      return { success: true, value };
    }
    return { success: false, error: 'No value found at path' };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Extraction failed',
    };
  }
}
