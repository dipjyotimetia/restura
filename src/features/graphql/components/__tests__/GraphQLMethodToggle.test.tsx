import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { GraphQLMethodToggle } from '../GraphQLMethodToggle';

const DOC = 'query ListUsers { users { id } }\nmutation AddUser { addUser { id } }';

describe('GraphQLMethodToggle', () => {
  it('turns red on GET only when the selected operation is a mutation', () => {
    const { rerender } = render(
      <GraphQLMethodToggle
        method="GET"
        isSubscription={false}
        query={DOC}
        operationName="ListUsers"
        onChange={() => undefined}
      />
    );
    const chip = screen.getByRole('button', { name: /GraphQL HTTP method: GET/ });
    expect(chip.getAttribute('title')).toMatch(/queries only/);
    expect(chip.className).not.toMatch(/destructive/);

    rerender(
      <GraphQLMethodToggle
        method="GET"
        isSubscription={false}
        query={DOC}
        operationName="AddUser"
        onChange={() => undefined}
      />
    );
    expect(chip.getAttribute('title')).toMatch(/switch the method to POST.*mutation/);
    expect(chip.className).toMatch(/destructive/);
  });

  it('toggles POST to GET and shows a static SUB chip for subscriptions', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <GraphQLMethodToggle method="POST" isSubscription={false} query={DOC} onChange={onChange} />
    );
    fireEvent.click(screen.getByRole('button', { name: /GraphQL HTTP method: POST/ }));
    expect(onChange).toHaveBeenCalledWith('GET');

    rerender(
      <GraphQLMethodToggle
        method="POST"
        isSubscription
        query="subscription { s }"
        onChange={onChange}
      />
    );
    expect(screen.getByLabelText('GraphQL subscription').textContent).toBe('SUB');
  });
});
