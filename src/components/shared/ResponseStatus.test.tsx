import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ResponseStatus } from './ResponseStatus';

describe('ResponseStatus', () => {
  it('explains the status on keyboard focus', async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider delayDuration={0}>
        <ResponseStatus status={429} statusText="Too Many Requests" />
      </TooltipProvider>
    );
    expect(screen.getByText('429')).toBeInTheDocument();
    await user.tab();
    expect((await screen.findAllByText(/rate limited/)).length).toBeGreaterThan(0);
  });

  it('renders just the pill when there is no HTTP status to explain', () => {
    const { container } = render(<ResponseStatus status={0} statusText="Error" />);
    expect(container.querySelector('[tabindex="0"]')).toBeNull();
    expect(screen.getByText('0')).toBeInTheDocument();
  });
});
