import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AuthInputSchema,
  CONTROL_TOOL_NAMES,
  CONTROL_TOOLS,
  getControlTool,
  NewRequestInputSchema,
  RequestPatchSchema,
} from '../control-tools';
import { TOOLS as SNAPSHOT_TOOLS } from '../dispatch';

describe('control tool catalogue', () => {
  it('has unique snake_case names', () => {
    expect(new Set(CONTROL_TOOL_NAMES).size).toBe(CONTROL_TOOL_NAMES.length);
    for (const name of CONTROL_TOOL_NAMES) expect(name).toMatch(/^[a-z][a-z0-9_]+$/);
  });

  it('includes every snapshot read tool so the renderer can reuse the pure dispatcher', () => {
    for (const name of Object.keys(SNAPSHOT_TOOLS)) {
      expect(getControlTool(name)?.tier).toBe('read');
    }
  });

  it('declares annotations honestly for each tier', () => {
    for (const tool of CONTROL_TOOLS) {
      const a = tool.annotations;
      expect(a.title).toBe(tool.title);
      expect(a.readOnlyHint).toBe(tool.tier === 'read' || tool.tier === 'ui');
      expect(a.destructiveHint).toBe(tool.tier === 'destructive');
      expect(a.openWorldHint).toBe(tool.tier === 'execute');
      if (tool.tier === 'execute') expect(a.idempotentHint).toBe(false);
    }
  });

  it('every input schema converts to a JSON Schema object (what MCP clients receive)', () => {
    for (const tool of CONTROL_TOOLS) {
      const json = z.toJSONSchema(tool.inputSchema, { io: 'input' }) as { type?: string };
      expect(json.type).toBe('object');
    }
  });

  it('exposes no tool that could widen the agent’s own access', () => {
    const forbidden =
      /consent|setting|secret_store|vault|proxy|certificate|telemetry|updater|provider|token|key/;
    for (const name of CONTROL_TOOL_NAMES) {
      if (name === 'request_secret_variable') continue; // writes a value the USER types; never reads
      expect(name).not.toMatch(forbidden);
    }
  });

  it('every execute and destructive tool says it asks the user', () => {
    for (const tool of CONTROL_TOOLS) {
      if (tool.tier === 'execute' || tool.tier === 'destructive') {
        expect(tool.description).toMatch(/Always asks the user/);
      }
    }
  });
});

describe('credential inputs only accept {{variable}} references', () => {
  it('accepts a bare variable reference', () => {
    expect(AuthInputSchema.safeParse({ type: 'bearer', token: '{{apiToken}}' }).success).toBe(true);
    expect(AuthInputSchema.safeParse({ type: 'bearer', token: '{{ api.token }}' }).success).toBe(
      true
    );
  });

  it.each(['sk-live-123', 'Bearer {{apiToken}}', '{{apiToken}} extra', '{{}}', '', '{{a}}{{b}}'])(
    'refuses %j',
    (token) => {
      expect(AuthInputSchema.safeParse({ type: 'bearer', token }).success).toBe(false);
    }
  );

  it('applies to basic passwords and api-key values', () => {
    expect(
      AuthInputSchema.safeParse({ type: 'basic', username: 'u', password: 'hunter2' }).success
    ).toBe(false);
    expect(AuthInputSchema.safeParse({ type: 'api-key', key: 'X-Key', value: 'abc' }).success).toBe(
      false
    );
    expect(
      AuthInputSchema.safeParse({ type: 'api-key', key: 'X-Key', value: '{{k}}' }).success
    ).toBe(true);
  });

  it('refuses auth kinds an agent cannot configure safely (oauth2, aws, ntlm …)', () => {
    expect(AuthInputSchema.safeParse({ type: 'oauth2', accessToken: '{{t}}' }).success).toBe(false);
  });
});

describe('request inputs', () => {
  it('does not offer the stdio MCP transport (it would launch a local command)', () => {
    expect(
      NewRequestInputSchema.safeParse({ type: 'mcp', name: 'x', url: 'u', transport: 'stdio' })
        .success
    ).toBe(false);
    expect(
      NewRequestInputSchema.safeParse({ type: 'mcp', name: 'x', url: 'https://mcp.example' })
        .success
    ).toBe(true);
  });

  it('defaults an http request to GET and rejects non-letter methods', () => {
    const parsed = NewRequestInputSchema.parse({ type: 'http', name: 'n', url: '{{base}}/x' });
    expect(parsed.type === 'http' && parsed.method).toBe('GET');
    expect(
      NewRequestInputSchema.safeParse({ type: 'http', name: 'n', url: 'u', method: 'GET /x' })
        .success
    ).toBe(false);
  });

  it('a patch must change something and may not carry unknown fields', () => {
    expect(RequestPatchSchema.safeParse({}).success).toBe(false);
    expect(RequestPatchSchema.safeParse({ type: 'grpc' }).success).toBe(false);
    expect(RequestPatchSchema.safeParse({ url: 'https://x' }).success).toBe(true);
  });
});
