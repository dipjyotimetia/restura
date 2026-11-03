import { describe, expect, it } from 'vitest';
import { AGENT_TOOL_TIMEOUT_SEC, agentConfigs } from '../ConnectAgent';

describe('agentConfigs', () => {
  it('builds Claude Code, Codex and Claude Desktop configs from the launch command', () => {
    const configs = agentConfigs({
      command: '/home/u/Apps/Restura.AppImage',
      args: ['--mcp-server'],
    });
    expect(configs.claudeCode).toBe(
      'claude mcp add restura -- /home/u/Apps/Restura.AppImage --mcp-server'
    );
    expect(configs.codex).toContain('command = "/home/u/Apps/Restura.AppImage"');
    expect(configs.codex).toContain('args = ["--mcp-server"]');
    expect(configs.codex).toContain(`tool_timeout_sec = ${AGENT_TOOL_TIMEOUT_SEC}`);
    expect(JSON.parse(configs.claudeDesktop)).toEqual({
      mcpServers: {
        restura: { command: '/home/u/Apps/Restura.AppImage', args: ['--mcp-server'] },
      },
    });
  });

  it('quotes paths with spaces and passes a custom user data folder on', () => {
    const configs = agentConfigs({
      command: 'C:\\Program Files\\Restura\\Restura.exe',
      args: ['C:\\dev\\main.js', '--mcp-server'],
      env: { RESTURA_USER_DATA_DIR: '/tmp/my profile' },
    });
    expect(configs.claudeCode).toBe(
      'claude mcp add restura -e "RESTURA_USER_DATA_DIR=/tmp/my profile" -- "C:\\\\Program Files\\\\Restura\\\\Restura.exe" "C:\\\\dev\\\\main.js" --mcp-server'
    );
    expect(configs.codex).toContain('env = { RESTURA_USER_DATA_DIR = "/tmp/my profile" }');
    expect(JSON.parse(configs.claudeDesktop).mcpServers.restura.env).toEqual({
      RESTURA_USER_DATA_DIR: '/tmp/my profile',
    });
  });
});
