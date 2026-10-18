import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import {
  isMcpNotificationMethod,
  isValidMcpProtocolVersion,
  MCP_LATEST_PROTOCOL_VERSION,
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
} from './mcp-version';

describe('MCP protocol version constants', () => {
  it('web offers the same initialize version as the desktop/CLI SDK (#862)', () => {
    expect(MCP_LATEST_PROTOCOL_VERSION).toBe(LATEST_PROTOCOL_VERSION);
  });

  it('every web-supported version is one the SDK also supports', () => {
    for (const v of MCP_SUPPORTED_PROTOCOL_VERSIONS) {
      expect(SUPPORTED_PROTOCOL_VERSIONS).toContain(v);
    }
    expect(MCP_SUPPORTED_PROTOCOL_VERSIONS[0]).toBe(MCP_LATEST_PROTOCOL_VERSION);
  });

  it('accepts date-shaped versions and rejects header-unsafe values', () => {
    expect(isValidMcpProtocolVersion('2025-06-18')).toBe(true);
    expect(isValidMcpProtocolVersion('')).toBe(false);
    expect(isValidMcpProtocolVersion('2025-06-18\r\nX-Evil: 1')).toBe(false);
    expect(isValidMcpProtocolVersion('a'.repeat(65))).toBe(false);
    expect(isValidMcpProtocolVersion(20250618)).toBe(false);
  });

  it('classifies notification methods', () => {
    expect(isMcpNotificationMethod('notifications/initialized')).toBe(true);
    expect(isMcpNotificationMethod('tools/list')).toBe(false);
  });
});
