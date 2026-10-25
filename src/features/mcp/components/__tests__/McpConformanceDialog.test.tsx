import type { McpConformanceReport } from '@shared/protocol/mcp-conformance';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpConformanceDialog } from '@/features/mcp/components/McpConformanceDialog';
import { McpConnectionPanel } from '@/features/mcp/components/McpConnectionPanel';
import type { McpConformanceRunInput } from '@/features/mcp/lib/mcpConformance';
import type { McpConnection } from '@/features/mcp/store/useMcpStore';

const report: McpConformanceReport = {
  schemaVersion: 1,
  generatedAt: '2026-10-18T00:00:00.000Z',
  target: 'https://h.example/mcp',
  options: { sampleCalls: 'off', approvedTools: [] },
  eras: [
    {
      era: 'legacy',
      status: 'ok',
      protocolVersion: '2025-06-18',
      listing: { tools: [{ name: 'a', fields: {} }], resources: [], prompts: [] },
      samples: [],
      findings: [],
      durationMs: 1,
    },
    {
      era: 'modern',
      status: 'unsupported',
      listing: { tools: [], resources: [], prompts: [] },
      samples: [],
      findings: [],
      durationMs: 1,
    },
  ],
  diff: null,
  findings: [
    {
      code: 'tools.output-schema-mismatch',
      severity: 'error',
      era: 'legacy',
      subject: 'a',
      message: '$.n: expected number',
    },
  ],
  summary: { errors: 1, warnings: 0, info: 0 },
};

const endpoint = () => ({
  url: 'https://h.example/mcp',
  transport: 'streamable-http' as const,
  headers: { Authorization: 'Bearer x' },
});

afterEach(() => vi.restoreAllMocks());

describe('McpConformanceDialog (#911)', () => {
  it('runs with the resolved endpoint and renders the report', async () => {
    const run = vi.fn().mockResolvedValue({ ok: true, report });
    render(
      <McpConformanceDialog
        open
        onOpenChange={vi.fn()}
        getEndpoint={endpoint}
        tools={[]}
        run={run}
      />
    );
    await userEvent.click(screen.getByRole('button', { name: /run conformance check/i }));
    await waitFor(() => expect(screen.getByTestId('conformance-report')).toBeInTheDocument());
    expect(run).toHaveBeenCalledWith({
      url: 'https://h.example/mcp',
      transport: 'streamable-http',
      headers: { Authorization: 'Bearer x' },
      sampleCalls: 'off',
      approvedTools: [],
    });
    expect(screen.getByText(/\$\.n: expected number/)).toBeInTheDocument();
    expect(screen.getByText(/both eras must connect/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /export markdown/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /export json/i })).toBeInTheDocument();
  });

  it('exports Markdown and JSON downloads', async () => {
    const run = vi.fn().mockResolvedValue({ ok: true, report });
    const blobs: Blob[] = [];
    const create = vi.fn((b: Blob) => {
      blobs.push(b);
      return 'blob:x';
    });
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    render(
      <McpConformanceDialog
        open
        onOpenChange={vi.fn()}
        getEndpoint={endpoint}
        tools={[]}
        run={run}
      />
    );
    await userEvent.click(screen.getByRole('button', { name: /run conformance check/i }));
    await userEvent.click(await screen.findByRole('button', { name: /export markdown/i }));
    await userEvent.click(screen.getByRole('button', { name: /export json/i }));
    expect(click).toHaveBeenCalledTimes(2);
    expect(await blobs[0]?.text()).toContain('# MCP conformance report');
    expect(JSON.parse((await blobs[1]?.text()) ?? '{}').schemaVersion).toBe(1);
  });

  it('fails closed (never probes anonymously) when the endpoint auth cannot be applied', async () => {
    const run = vi.fn();
    render(
      <McpConformanceDialog
        open
        onOpenChange={vi.fn()}
        getEndpoint={() => ({ error: 'Bearer auth is selected but its credential is empty.' })}
        tools={[]}
        run={run}
      />
    );
    await userEvent.click(screen.getByRole('button', { name: /run conformance check/i }));
    expect(
      await screen.findByText('Bearer auth is selected but its credential is empty.')
    ).toBeInTheDocument();
    expect(run).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /run conformance check/i })).toBeEnabled();
  });

  it('forwards main-side auth (handles stay handles) to the run', async () => {
    const run = vi.fn().mockResolvedValue({ ok: true, report });
    const auth = {
      type: 'bearer' as const,
      bearer: { token: { kind: 'handle' as const, id: 'h-1' } },
    };
    render(
      <McpConformanceDialog
        open
        onOpenChange={vi.fn()}
        getEndpoint={() => ({ ...endpoint(), headers: {}, auth })}
        tools={[]}
        run={run}
      />
    );
    await userEvent.click(screen.getByRole('button', { name: /run conformance check/i }));
    await waitFor(() => expect(run).toHaveBeenCalled());
    expect(run.mock.calls[0]?.[0]).toMatchObject({ headers: {}, auth });
  });

  it('shows the error when the run fails', async () => {
    const run = vi.fn().mockResolvedValue({ ok: false, error: 'boom' });
    render(
      <McpConformanceDialog
        open
        onOpenChange={vi.fn()}
        getEndpoint={endpoint}
        tools={[]}
        run={run}
      />
    );
    await userEvent.click(screen.getByRole('button', { name: /run conformance check/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('boom');
  });

  it('only offers non-destructive, non-read-only tools for approval and sends the chosen ones', async () => {
    const run = vi.fn().mockResolvedValue({ ok: true, report });
    render(
      <McpConformanceDialog
        open
        onOpenChange={vi.fn()}
        getEndpoint={endpoint}
        tools={[
          { name: 'plain' },
          { name: 'peek', annotations: { readOnlyHint: true } },
          { name: 'rm_rf', annotations: { destructiveHint: true } },
        ]}
        run={run}
      />
    );
    await userEvent.click(screen.getByLabelText(/read-only \+ chosen tools/i));
    expect(screen.getByLabelText('plain')).toBeInTheDocument();
    expect(screen.queryByLabelText('peek')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('rm_rf')).not.toBeInTheDocument();
    await userEvent.click(screen.getByLabelText('plain'));
    await userEvent.click(screen.getByRole('button', { name: /run conformance check/i }));
    const call = run.mock.calls[0]?.[0] as McpConformanceRunInput;
    expect(call.sampleCalls).toBe('selected');
    expect(call.approvedTools).toEqual(['plain']);
  });

  it('does not send approvals unless selected mode is active', async () => {
    const run = vi.fn().mockResolvedValue({ ok: true, report });
    render(
      <McpConformanceDialog
        open
        onOpenChange={vi.fn()}
        getEndpoint={endpoint}
        tools={[{ name: 'plain' }]}
        run={run}
      />
    );
    await userEvent.click(screen.getByLabelText(/read-only \+ chosen tools/i));
    await userEvent.click(screen.getByLabelText('plain'));
    await userEvent.click(screen.getByLabelText(/^read-only tools/i));
    await userEvent.click(screen.getByRole('button', { name: /run conformance check/i }));
    const call = run.mock.calls[0]?.[0] as McpConformanceRunInput;
    expect(call.sampleCalls).toBe('read-only');
    expect(call.approvedTools).toEqual([]);
  });
});

describe('McpConnectionPanel conformance action', () => {
  const connection = {
    id: 'c1',
    url: 'https://h.example/mcp',
    transport: 'streamable-http',
    headers: [],
    status: 'disconnected',
  } as unknown as McpConnection;
  const props = {
    showCatalog: false,
    onToggleCatalog: vi.fn(),
    onUrlChange: vi.fn(),
    onTransportChange: vi.fn(),
    onHeadersChange: vi.fn(),
    requestId: 'req-1',
    auth: { type: 'none' as const },
    onAuthChange: vi.fn(),
    onConnect: vi.fn(),
    onDisconnect: vi.fn(),
    onRefresh: vi.fn(),
  };

  it('is available without a live connection and fires the callback', async () => {
    const onConformance = vi.fn();
    render(<McpConnectionPanel {...props} connection={connection} onConformance={onConformance} />);
    await userEvent.click(screen.getByRole('button', { name: /conformance/i }));
    expect(onConformance).toHaveBeenCalled();
  });

  it('is disabled with no URL', () => {
    render(
      <McpConnectionPanel
        {...props}
        connection={{ ...connection, url: '' }}
        onConformance={vi.fn()}
      />
    );
    expect(screen.getByRole('button', { name: /conformance/i })).toBeDisabled();
  });
});

describe('McpConformanceDialog report variants', () => {
  it('renders a diff summary, empty findings, subject-less findings, and un-ticking tools', async () => {
    const withDiff = {
      ...report,
      diff: {} as unknown as McpConformanceReport['diff'],
      findings: [
        {
          code: 'diff.tool',
          severity: 'warning' as const,
          era: 'cross-era' as const,
          message: 'm',
        },
      ],
    };
    const run = vi.fn().mockResolvedValue({ ok: true, report: withDiff });
    render(
      <McpConformanceDialog
        open
        onOpenChange={vi.fn()}
        getEndpoint={endpoint}
        tools={[{ name: 'plain' }]}
        run={run}
      />
    );
    await userEvent.click(screen.getByLabelText(/read-only \+ chosen tools/i));
    await userEvent.click(screen.getByLabelText('plain'));
    await userEvent.click(screen.getByLabelText('plain'));
    await userEvent.click(screen.getByRole('button', { name: /run conformance check/i }));
    expect(await screen.findByTestId('conformance-diff')).toHaveTextContent('1 difference');
    expect((run.mock.calls[0]?.[0] as McpConformanceRunInput).approvedTools).toEqual([]);
  });

  it('shows "No findings." and an empty-tools hint', async () => {
    const run = vi.fn().mockResolvedValue({ ok: true, report: { ...report, findings: [] } });
    render(
      <McpConformanceDialog
        open
        onOpenChange={vi.fn()}
        getEndpoint={endpoint}
        tools={[]}
        run={run}
      />
    );
    await userEvent.click(screen.getByLabelText(/read-only \+ chosen tools/i));
    expect(screen.getByText(/connect and discover tools first/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /run conformance check/i }));
    expect(await screen.findByText('No findings.')).toBeInTheDocument();
  });
});
