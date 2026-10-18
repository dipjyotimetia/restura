import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpArgumentField } from '@/features/mcp/components/McpArgumentField';
import { McpInvokeForm } from '@/features/mcp/components/McpInvokeForm';
import { McpLogLevelPicker } from '@/features/mcp/components/McpLogLevelPicker';
import { McpPingButton } from '@/features/mcp/components/McpPingButton';
import { McpTemplateForm } from '@/features/mcp/components/McpTemplateForm';
import { McpTemplatesPanel } from '@/features/mcp/components/McpTemplatesPanel';

describe('McpTemplatesPanel', () => {
  it('lists templates and reports selection', () => {
    const onSelect = vi.fn();
    render(
      <McpTemplatesPanel
        templates={[{ uriTemplate: 'file:///{path}', name: 'Files', description: 'Any file' }]}
        selected={null}
        onSelect={onSelect}
      />
    );
    fireEvent.click(screen.getByText('Files'));
    expect(onSelect).toHaveBeenCalledWith('file:///{path}');
    expect(screen.getByText('Any file')).toBeTruthy();
  });

  it('shows an empty state', () => {
    render(<McpTemplatesPanel templates={[]} selected={null} onSelect={vi.fn()} />);
    expect(screen.getByText('No templates')).toBeTruthy();
  });
});

describe('McpTemplateForm', () => {
  const template = { uriTemplate: 'users://{id}/docs{?page}', name: 'User docs' };

  it('substitutes escaped parameters, previews, and reads the expanded URI', async () => {
    const onRead = vi.fn().mockResolvedValue(undefined);
    render(<McpTemplateForm template={template} onRead={onRead} />);
    const [id, page] = screen.getAllByPlaceholderText('string') as HTMLInputElement[];
    fireEvent.change(id as HTMLInputElement, { target: { value: 'a b/c' } });
    expect(screen.getByTestId('mcp-template-preview').textContent).toBe('users://a%20b%2Fc/docs');
    fireEvent.change(page as HTMLInputElement, { target: { value: '2' } });
    expect(screen.getByTestId('mcp-template-preview').textContent).toBe(
      'users://a%20b%2Fc/docs?page=2'
    );
    fireEvent.click(screen.getByRole('button', { name: /read/i }));
    await waitFor(() => expect(onRead).toHaveBeenCalledWith('users://a%20b%2Fc/docs?page=2'));
  });

  it('requires path variables but not query variables', async () => {
    const onRead = vi.fn().mockResolvedValue(undefined);
    render(<McpTemplateForm template={template} onRead={onRead} />);
    fireEvent.click(screen.getByRole('button', { name: /read/i }));
    expect((await screen.findAllByRole('alert')).length).toBe(1);
    expect(onRead).not.toHaveBeenCalled();
  });

  it('passes completion context excluding the field itself', async () => {
    vi.useFakeTimers();
    try {
      const onComplete = vi.fn().mockResolvedValue(['42']);
      render(
        <McpTemplateForm
          template={{ uriTemplate: 'x://{a}/{b}', name: 'T' }}
          onRead={vi.fn()}
          onComplete={onComplete}
        />
      );
      const [a, b] = screen.getAllByPlaceholderText('string') as HTMLInputElement[];
      fireEvent.change(a as HTMLInputElement, { target: { value: 'one' } });
      fireEvent.focus(b as HTMLInputElement);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(onComplete).toHaveBeenLastCalledWith(
        'x://{a}/{b}',
        { name: 'b', value: '' },
        { a: 'one' }
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders a placeholder when nothing is selected', () => {
    render(<McpTemplateForm template={null} onRead={vi.fn()} />);
    expect(screen.getByText(/select a resource template/i)).toBeTruthy();
  });
});

describe('completion in argument fields', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const field = { name: 'q', type: 'string', required: false, isComplex: false };

  it('debounces completion/complete and applies a picked suggestion', async () => {
    const complete = vi.fn().mockResolvedValue(['alpha', 'alps']);
    const onChange = vi.fn();
    const { rerender } = render(
      <McpArgumentField field={field} value="" onChange={onChange} complete={complete} />
    );
    const input = screen.getByPlaceholderText('string');
    fireEvent.focus(input);
    rerender(<McpArgumentField field={field} value="a" onChange={onChange} complete={complete} />);
    rerender(<McpArgumentField field={field} value="al" onChange={onChange} complete={complete} />);
    expect(complete).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith('al');
    fireEvent.mouseDown(screen.getByText('alps'));
    expect(onChange).toHaveBeenCalledWith('alps');
  });

  it('does not query when unfocused or when no completer is given', async () => {
    const complete = vi.fn().mockResolvedValue(['x']);
    render(<McpArgumentField field={field} value="a" onChange={vi.fn()} complete={complete} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(complete).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('completes prompt arguments with the other arguments as context', async () => {
    const onCompletePrompt = vi.fn().mockResolvedValue(['en', 'es']);
    render(
      <McpInvokeForm
        tab="prompts"
        tool={null}
        prompt={{
          name: 'greet',
          arguments: [{ name: 'name' }, { name: 'lang' }],
        }}
        onCall={vi.fn()}
        onGet={vi.fn()}
        promptArguments={{ name: 'Ada' }}
        onCompletePrompt={onCompletePrompt}
      />
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const lang = screen.getByLabelText('lang');
    fireEvent.focus(lang);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(onCompletePrompt).toHaveBeenCalledWith(
      'greet',
      { name: 'lang', value: '' },
      { name: 'Ada' }
    );
    expect(screen.getByText('es')).toBeTruthy();
  });
});

describe('McpLogLevelPicker', () => {
  it('sends the chosen level', async () => {
    const onSetLevel = vi.fn().mockResolvedValue({ ok: true });
    render(<McpLogLevelPicker onSetLevel={onSetLevel} />);
    fireEvent.change(screen.getByLabelText('Log level'), { target: { value: 'warning' } });
    await waitFor(() => expect(onSetLevel).toHaveBeenCalledWith('warning'));
    expect((screen.getByLabelText('Log level') as HTMLSelectElement).value).toBe('warning');
  });

  it('reverts and shows the error when the server rejects', async () => {
    const onSetLevel = vi.fn().mockResolvedValue({ ok: false, error: 'bad level' });
    render(<McpLogLevelPicker onSetLevel={onSetLevel} />);
    fireEvent.change(screen.getByLabelText('Log level'), { target: { value: 'debug' } });
    expect((await screen.findByRole('alert')).textContent).toBe('bad level');
    expect((screen.getByLabelText('Log level') as HTMLSelectElement).value).toBe('');
  });
});

describe('McpPingButton', () => {
  it('shows the round-trip time', async () => {
    const onPing = vi.fn().mockResolvedValue({ ok: true, durationMs: 41.6 });
    render(<McpPingButton onPing={onPing} />);
    fireEvent.click(screen.getByRole('button', { name: /ping/i }));
    expect((await screen.findByRole('status')).textContent).toBe('42 ms');
  });

  it('shows the failure', async () => {
    const onPing = vi.fn().mockResolvedValue({ ok: false, durationMs: 5, error: 'timed out' });
    render(<McpPingButton onPing={onPing} />);
    fireEvent.click(screen.getByRole('button', { name: /ping/i }));
    expect((await screen.findByRole('status')).textContent).toBe('timed out');
  });
});
