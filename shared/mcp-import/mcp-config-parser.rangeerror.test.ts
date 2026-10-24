import { describe, expect, it, vi } from 'vitest';

vi.mock('jsonc-parser', () => ({
  parse: () => {
    throw new RangeError('Maximum call stack size exceeded at /secret/path');
  },
}));

import { McpConfigParseError, parseMcpConfigText } from './mcp-config-parser';

describe('unexpected parser failures (L6)', () => {
  it('map to a generic message without leaking internals', () => {
    try {
      parseMcpConfigText('{}');
      throw new Error('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(McpConfigParseError);
      expect((err as Error).message).toBe('Could not parse the config');
    }
  });
});
