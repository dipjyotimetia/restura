import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { GrpcStatusDetailsView } from '../GrpcStatusDetailsView';

const badRequest = {
  type: 'google.rpc.BadRequest',
  value: {
    fieldViolations: [
      { field: 'user.email', description: 'invalid', reason: 'FORMAT' },
      { field: '', description: 'request rejected' },
    ],
  },
};

describe('GrpcStatusDetailsView', () => {
  it('lists violations with their reasons and jumps to the clicked one', async () => {
    const onJump = vi.fn();
    render(<GrpcStatusDetailsView details={[badRequest]} onJumpToViolation={onJump} />);
    const list = screen.getByRole('region', { name: 'Field violations' });
    const [email, whole] = within(list).getAllByRole('button');
    expect(email).toHaveTextContent('user.emailinvalidFORMAT');
    expect(email).toHaveAttribute('title', 'Show this field in the request message');
    expect(whole).toHaveTextContent('(request)request rejected');
    await userEvent.click(whole as HTMLElement);
    expect(onJump).toHaveBeenCalledWith(1);
  });

  it('renders violations as inert when there is no editor to jump to', () => {
    render(<GrpcStatusDetailsView details={[badRequest]} />);
    for (const button of screen.getAllByRole('button')) {
      expect(button).toBeDisabled();
      expect(button).not.toHaveAttribute('title');
    }
  });

  it('shows raw bytes (or an empty marker) for undecoded types, plus debug info', () => {
    render(
      <GrpcStatusDetailsView
        details={[
          { type: 'Opaque', raw: '', debug: { trace: 'abc' } },
          { type: 'acme.v1.Custom', raw: 'AQI=' },
        ]}
      />
    );
    const cards = within(screen.getByRole('list', { name: 'Error details' })).getAllByRole(
      'listitem'
    );
    expect(cards[0]).toHaveTextContent('Opaque');
    expect(cards[0]).toHaveTextContent('(empty)');
    expect(cards[0]).toHaveTextContent('"trace": "abc"');
    expect(cards[1]).toHaveTextContent('Custom');
    expect(cards[1]).toHaveTextContent('AQI=');
    expect(screen.queryByRole('region', { name: 'Field violations' })).not.toBeInTheDocument();
  });
});
