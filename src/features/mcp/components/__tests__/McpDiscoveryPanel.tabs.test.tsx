import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  McpDiscoveryPanel,
  type McpDiscoveryTab,
} from '@/features/mcp/components/McpDiscoveryPanel';
import type { McpInvocationLog } from '@/features/mcp/store/useMcpStore';

const log: McpInvocationLog[] = [
  { id: '1', method: 'ping', timestamp: 1, durationMs: 12 },
  { id: '2', method: 'tools/call:x', timestamp: 2, durationMs: 3, error: 'boom' },
];

function Harness({
  initial = 'tools',
  templates,
  onReadResource = vi.fn().mockResolvedValue(undefined),
  onTemplateSelect = vi.fn(),
  onToolSelect = vi.fn(),
  onPromptSelect = vi.fn(),
  onClearLog = vi.fn(),
  empty = false,
}: {
  initial?: McpDiscoveryTab;
  templates?: Array<{ uriTemplate: string; name: string }>;
  onReadResource?: (uri: string) => Promise<void>;
  onTemplateSelect?: (uri: string) => void;
  onToolSelect?: (n: string) => void;
  onPromptSelect?: (n: string) => void;
  onClearLog?: () => void;
  empty?: boolean;
}) {
  const [tab, setTab] = useState<McpDiscoveryTab>(initial);
  return (
    <McpDiscoveryPanel
      tools={
        empty ? [] : [{ name: 'echo', description: 'Echo', inputSchema: { properties: { a: {} } } }]
      }
      resources={
        empty ? [] : [{ uri: 'res://a', name: 'A', description: 'd', mimeType: 'text/plain' }]
      }
      templates={templates}
      selectedTemplateUri={null}
      onTemplateSelect={onTemplateSelect}
      prompts={empty ? [] : [{ name: 'greet', description: 'Hi', arguments: [{ name: 'n' }] }]}
      log={empty ? [] : log}
      selectedToolName="echo"
      selectedPromptName={null}
      onToolSelect={onToolSelect}
      onPromptSelect={onPromptSelect}
      onReadResource={onReadResource}
      onClearLog={onClearLog}
      onHide={vi.fn()}
      tab={tab}
      onTabChange={setTab}
    />
  );
}

describe('McpDiscoveryPanel', () => {
  it('hides the Templates tab unless templates are provided', () => {
    render(<Harness />);
    expect(screen.queryByRole('tab', { name: /templates/i })).toBeNull();
  });

  it('shows templates and forwards selection', () => {
    const onTemplateSelect = vi.fn();
    render(
      <Harness
        initial="templates"
        templates={[{ uriTemplate: 'u://{id}', name: 'Tmpl' }]}
        onTemplateSelect={onTemplateSelect}
      />
    );
    fireEvent.click(screen.getByText('Tmpl'));
    expect(onTemplateSelect).toHaveBeenCalledWith('u://{id}');
  });

  it('selects tools and prompts', () => {
    const onToolSelect = vi.fn();
    const onPromptSelect = vi.fn();
    render(<Harness onToolSelect={onToolSelect} onPromptSelect={onPromptSelect} />);
    fireEvent.click(screen.getByText('echo'));
    expect(onToolSelect).toHaveBeenCalledWith('echo');
    fireEvent.click(screen.getByRole('tab', { name: /prompts/i }));
    fireEvent.click(screen.getByText('greet'));
    expect(onPromptSelect).toHaveBeenCalledWith('greet');
  });

  it('reads a resource', async () => {
    const onReadResource = vi.fn().mockResolvedValue(undefined);
    render(<Harness initial="resources" onReadResource={onReadResource} />);
    fireEvent.click(screen.getByRole('button', { name: 'Read' }));
    await waitFor(() => expect(onReadResource).toHaveBeenCalledWith('res://a'));
  });

  it('lists and clears the call log', () => {
    const onClearLog = vi.fn();
    render(<Harness initial="log" onClearLog={onClearLog} />);
    expect(screen.getByText('ping')).toBeTruthy();
    expect(screen.getByText('ERR')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /clear/i }));
    expect(onClearLog).toHaveBeenCalled();
  });

  it('renders empty states for every tab', () => {
    render(<Harness empty templates={[]} />);
    expect(screen.getByText('No tools')).toBeTruthy();
    for (const [name, text] of [
      [/resources/i, 'No resources'],
      [/templates/i, 'No templates'],
      [/prompts/i, 'No prompts'],
      [/log/i, 'No calls yet'],
    ] as const) {
      fireEvent.click(screen.getByRole('tab', { name }));
      expect(screen.getByText(text)).toBeTruthy();
    }
  });
});
