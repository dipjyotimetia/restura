import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ProtocolCodeDialog } from './ProtocolCodeDialog';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const generators = {
  a: { name: 'Alpha', generate: (o: { x: string }) => `alpha ${o.x}` },
  b: { name: 'Beta', generate: (o: { x: string }) => `beta ${o.x}` },
};

describe('ProtocolCodeDialog', () => {
  it('shows the first generator, switches language and copies', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(
      <ProtocolCodeDialog
        open
        onOpenChange={() => {}}
        title="Code"
        generators={generators}
        options={{ x: '1' }}
      />
    );
    expect(screen.getByText('alpha 1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Beta' }));
    expect(screen.getByText('beta 1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /copy/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('beta 1'));
  });
});
