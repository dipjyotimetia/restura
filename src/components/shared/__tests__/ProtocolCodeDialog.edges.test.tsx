import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProtocolCodeDialog, type ProtocolCodeGenerator } from '../ProtocolCodeDialog';

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast: toastMock }));

type Opts = { x: string };

const ok: Record<string, ProtocolCodeGenerator<Opts>> = {
  a: { name: 'Alpha', generate: (o) => `alpha ${o.x}` },
  b: { name: 'Beta', generate: (o) => `beta ${o.x}` },
};

function renderDialog(
  generators: Record<string, ProtocolCodeGenerator<Opts>>,
  extra: { open?: boolean; description?: string } = {}
) {
  return render(
    <ProtocolCodeDialog
      open={extra.open ?? true}
      onOpenChange={() => {}}
      title="Export"
      {...(extra.description !== undefined && { description: extra.description })}
      generators={generators}
      options={{ x: '1' }}
    />
  );
}

function mockClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
}

beforeEach(() => {
  toastMock.success.mockReset();
  toastMock.error.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ProtocolCodeDialog edge cases', () => {
  it('uses the default description unless one is given', () => {
    const { unmount } = renderDialog(ok);
    expect(screen.getByText(/export this request as code/i)).toBeInTheDocument();
    unmount();
    renderDialog(ok, { description: 'Custom words' });
    expect(screen.getByText('Custom words')).toBeInTheDocument();
  });

  it('shows a generator Error as an alert and disables Copy', () => {
    renderDialog({
      bad: {
        name: 'Bad',
        generate: () => {
          throw new Error('unsupported body');
        },
      },
    });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Could not generate code: unsupported body'
    );
    expect(screen.getByRole('button', { name: /copy/i })).toBeDisabled();
  });

  it('stringifies a non-Error throw', () => {
    renderDialog({
      bad: {
        name: 'Bad',
        generate: () => {
          throw 'plain failure';
        },
      },
    });
    expect(screen.getByRole('alert')).toHaveTextContent('plain failure');
  });

  it('renders nothing to copy with no generators', () => {
    renderDialog({});
    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.getByRole('figure')).toHaveAccessibleName('Generated code');
    expect(screen.getByRole('button', { name: /copy/i })).toBeDisabled();
  });

  it('does not generate while closed', () => {
    const generate = vi.fn(() => 'x');
    renderDialog({ a: { name: 'A', generate } }, { open: false });
    expect(generate).not.toHaveBeenCalled();
  });

  it('falls back to the first generator when the picked one disappears', () => {
    const { rerender } = renderDialog(ok);
    fireEvent.click(screen.getByRole('radio', { name: 'Beta' }));
    expect(screen.getByText('beta 1')).toBeInTheDocument();
    rerender(
      <ProtocolCodeDialog
        open
        onOpenChange={() => {}}
        title="Export"
        generators={{ a: ok.a! }}
        options={{ x: '1' }}
      />
    );
    expect(screen.getByText('alpha 1')).toBeInTheDocument();
  });

  it('shows "Copied!" after a copy and resets after two seconds', async () => {
    vi.useFakeTimers();
    mockClipboard(vi.fn().mockResolvedValue(undefined));
    renderDialog(ok);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /copy/i }));
    });
    expect(screen.getByRole('button', { name: /copied!/i })).toBeInTheDocument();
    expect(toastMock.success).toHaveBeenCalledWith('Copied to clipboard');
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByRole('button', { name: /^copy$/i })).toBeInTheDocument();
  });

  it('reports a copy failure with the error message', async () => {
    mockClipboard(vi.fn().mockRejectedValue(new Error('denied')));
    renderDialog(ok);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /copy/i }));
    });
    expect(toastMock.error).toHaveBeenCalledWith('Copy failed', { description: 'denied' });
  });

  it('reports a non-Error copy failure without a description', async () => {
    mockClipboard(vi.fn().mockRejectedValue('nope'));
    renderDialog(ok);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /copy/i }));
    });
    expect(toastMock.error).toHaveBeenCalledWith('Copy failed', { description: undefined });
  });
});
