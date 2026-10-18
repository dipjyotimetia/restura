import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { McpDiscoveryPanel } from '@/features/mcp/components/McpDiscoveryPanel';

function renderPanel(log: React.ComponentProps<typeof McpDiscoveryPanel>['log'] = []) {
  render(
    <McpDiscoveryPanel
      tools={[
        {
          name: 'rm_rf',
          title: 'Remove everything',
          annotations: { destructiveHint: true, openWorldHint: true },
        },
        { name: 'peek', annotations: { readOnlyHint: true } },
        { name: 'plain' },
      ]}
      resources={[]}
      prompts={[]}
      log={log}
      selectedToolName={null}
      selectedPromptName={null}
      onToolSelect={vi.fn()}
      onPromptSelect={vi.fn()}
      onReadResource={vi.fn()}
      onClearLog={vi.fn()}
      onHide={vi.fn()}
      tab={log.length > 0 ? 'log' : 'tools'}
      onTabChange={vi.fn()}
    />
  );
}

describe('McpDiscoveryPanel (#880, #868)', () => {
  it('shows display titles (with the programmatic name) and hint badges', () => {
    renderPanel();
    expect(screen.getByText('Remove everything')).toBeInTheDocument();
    expect(screen.getByText('rm_rf')).toBeInTheDocument();
    expect(screen.getByText('DESTRUCTIVE')).toBeInTheDocument();
    expect(screen.getByText('OPEN-WORLD')).toBeInTheDocument();
    expect(screen.getByText('READ-ONLY')).toBeInTheDocument();
    expect(screen.getAllByText('plain')).toHaveLength(1);
  });

  it('marks tool errors in the call log distinctly from protocol errors', () => {
    renderPanel([
      {
        id: '1',
        method: 'tools/call:a',
        result: { isError: true },
        durationMs: 1,
        timestamp: 1,
      },
      { id: '2', method: 'tools/call:b', error: 'boom', durationMs: 1, timestamp: 2 },
      { id: '3', method: 'tools/call:c', result: {}, durationMs: 1, timestamp: 3 },
    ]);
    expect(screen.getByText('TOOL ERR')).toBeInTheDocument();
    expect(screen.getByText('ERR')).toBeInTheDocument();
    expect(screen.getByText('OK')).toBeInTheDocument();
  });
});
