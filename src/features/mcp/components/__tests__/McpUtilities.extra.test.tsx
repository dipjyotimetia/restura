import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { McpArgumentField } from '@/features/mcp/components/McpArgumentField';
import { McpDiscoveryPanel } from '@/features/mcp/components/McpDiscoveryPanel';
import { McpLogLevelPicker } from '@/features/mcp/components/McpLogLevelPicker';
import { McpPingButton } from '@/features/mcp/components/McpPingButton';
import { McpTemplateForm } from '@/features/mcp/components/McpTemplateForm';
import { McpClient } from '@/features/mcp/lib/mcpClient';

describe('edge cases', () => {
  it('log picker falls back to a default error message', async () => {
    render(<McpLogLevelPicker onSetLevel={vi.fn().mockResolvedValue({ ok: false })} />);
    fireEvent.change(screen.getByLabelText('Log level'), { target: { value: 'info' } });
    expect((await screen.findByRole('alert')).textContent).toBe('logging/setLevel failed');
  });

  it('ping falls back to a default failure message', async () => {
    render(<McpPingButton onPing={vi.fn().mockResolvedValue({ ok: false, durationMs: 1 })} />);
    fireEvent.click(screen.getByRole('button', { name: /ping/i }));
    expect((await screen.findByRole('status')).textContent).toBe('Ping failed');
  });

  it('template form shows description and the no-parameter state', () => {
    render(
      <McpTemplateForm
        template={{ uriTemplate: 'static://x', name: 'S', description: 'Static one' }}
        onRead={vi.fn()}
      />
    );
    expect(screen.getByText('Static one')).toBeTruthy();
    expect(screen.getByText(/no parameters/i)).toBeTruthy();
  });

  it('argument field renders complex editors and errors', () => {
    render(
      <McpArgumentField
        field={{ name: 'o', type: 'array', required: true, isComplex: true }}
        value=""
        error="bad"
        onChange={vi.fn()}
      />
    );
    expect(screen.getByPlaceholderText('[]')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('bad');
  });

  it('completion failures yield no suggestions', async () => {
    vi.useFakeTimers();
    try {
      const complete = vi.fn().mockRejectedValue(new Error('x'));
      const { unmount } = render(
        <McpArgumentField
          field={{ name: 'q', type: 'string', required: false, isComplex: false }}
          value="a"
          onChange={vi.fn()}
          complete={complete}
        />
      );
      fireEvent.focus(screen.getByPlaceholderText('string'));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(complete).toHaveBeenCalled();
      expect(screen.queryByRole('listbox')).toBeNull();
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('discovery panel marks selected entries and singular arg counts', () => {
    const { rerender } = render(
      <McpDiscoveryPanel
        tools={[{ name: 't', inputSchema: { properties: { a: {} } } }, { name: 'u' }]}
        resources={[]}
        templates={[{ uriTemplate: 'a://{x}', name: 'Tm' }]}
        selectedTemplateUri="a://{x}"
        prompts={[{ name: 'p', arguments: [{ name: 'n' }] }, { name: 'q' }]}
        log={[]}
        selectedToolName="t"
        selectedPromptName="p"
        onToolSelect={vi.fn()}
        onPromptSelect={vi.fn()}
        onReadResource={vi.fn()}
        onClearLog={vi.fn()}
        onHide={vi.fn()}
        tab="tools"
        onTabChange={vi.fn()}
      />
    );
    expect(screen.getByText('1 arg')).toBeTruthy();
    expect(screen.getByText('0 args')).toBeTruthy();
    for (const tab of ['prompts', 'templates'] as const) {
      rerender(
        <McpDiscoveryPanel
          tools={[]}
          resources={[]}
          templates={[{ uriTemplate: 'a://{x}', name: 'Tm' }]}
          selectedTemplateUri="a://{x}"
          prompts={[{ name: 'p', arguments: [{ name: 'n' }] }, { name: 'q' }]}
          log={[]}
          selectedToolName="t"
          selectedPromptName="p"
          onToolSelect={vi.fn()}
          onPromptSelect={vi.fn()}
          onReadResource={vi.fn()}
          onClearLog={vi.fn()}
          onHide={vi.fn()}
          tab={tab}
          onTabChange={vi.fn()}
        />
      );
    }
    expect(screen.getByText('Tm')).toBeTruthy();
  });

  it('client.complete tolerates a missing completion payload', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ok: true, jsonRpc: { result: {} } })))
    );
    try {
      const c = new McpClient({
        url: 'https://m.example.com',
        transport: 'streamable-http',
        headers: {},
        connectionId: 'x',
      });
      await waitFor(async () =>
        expect(
          await c.complete({ type: 'ref/prompt', name: 'p' }, { name: 'a', value: '' })
        ).toEqual([])
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
