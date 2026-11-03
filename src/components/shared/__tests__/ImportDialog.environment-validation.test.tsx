import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import ImportDialog from '../ImportDialog';

// A Postman environment file whose shape the importer passes through as-is:
// a numeric value and no name. It must be rejected by the environment schema
// before it reaches the store, not persisted as a malformed environment.
const MALFORMED_ENV = JSON.stringify({
  values: [{ key: 'port', value: 8080 }],
  _postman_variable_scope: 'environment',
});

describe('ImportDialog environment validation', () => {
  beforeEach(() => {
    useEnvironmentStore.setState({ environments: [] });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('refuses a malformed imported environment with a visible error', async () => {
    const user = userEvent.setup();
    render(<ImportDialog open onOpenChange={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: /paste the file contents/i }));
    fireEvent.change(screen.getByLabelText('Paste import content'), {
      target: { value: MALFORMED_ENV },
    });
    await user.click(screen.getByRole('button', { name: /preview pasted postman/i }));
    await user.click(await screen.findByRole('button', { name: /confirm import/i }));

    expect(await screen.findByText(/environment validation failed/i)).toBeInTheDocument();
    expect(useEnvironmentStore.getState().environments).toEqual([]);
  });
});
