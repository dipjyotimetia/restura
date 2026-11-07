import { DEFAULT_MCP_SERVER_SETTINGS } from '@shared/mcp-server/settings';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useMcpServerRuntimeStore } from '../../store/useMcpServerRuntimeStore';
import { McpApprovalDialog } from '../McpApprovalDialog';

function setRedaction(redactResponseBodies: boolean) {
  const settings = useSettingsStore.getState().settings;
  useSettingsStore.setState({
    settings: {
      ...settings,
      mcpServer: { ...DEFAULT_MCP_SERVER_SETTINGS, redactResponseBodies },
    },
  });
}

function queueExecute() {
  act(() => {
    useMcpServerRuntimeStore.setState({
      approvals: [
        {
          callId: 'c1',
          tool: 'send_request',
          tier: 'execute',
          title: 'Send GET /users',
          details: ['GET https://api.example.com/users'],
          createdAt: Date.now(),
        },
      ],
    });
  });
}

describe('McpApprovalDialog — execute-tier redaction copy', () => {
  beforeEach(() => useMcpServerRuntimeStore.setState({ approvals: [] }));
  afterEach(() => useMcpServerRuntimeStore.setState({ approvals: [] }));

  it('says the response is redacted when redaction is on', () => {
    setRedaction(true);
    render(<McpApprovalDialog />);
    queueExecute();
    expect(screen.getByTestId('mcp-approval-dialog')).toHaveTextContent(
      /token-like fields\s+redacted/
    );
    expect(screen.queryByTestId('mcp-approval-unredacted-warning')).toBeNull();
  });

  it('warns that the response goes unredacted when redaction is off', () => {
    setRedaction(false);
    render(<McpApprovalDialog />);
    queueExecute();
    const warning = screen.getByTestId('mcp-approval-unredacted-warning');
    expect(warning).toHaveTextContent(
      'Responses are sent to the agent unredacted — tokens and credentials may be exposed'
    );
    expect(warning).toHaveAttribute('role', 'alert');
    expect(screen.getByTestId('mcp-approval-dialog')).not.toHaveTextContent(
      /token-like fields\s+redacted/
    );
  });
});
