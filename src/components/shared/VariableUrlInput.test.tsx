import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useGlobalsStore } from '@/store/useGlobalsStore';
import { VariableUrlInput } from './VariableUrlInput';

function Harness({ initial, invalid }: { initial: string; invalid?: boolean }) {
  const [value, setValue] = useState(initial);
  return (
    <VariableUrlInput
      value={value}
      onValueChange={setValue}
      variableScope="connection"
      aria-label="WebSocket URL"
      invalid={invalid}
    />
  );
}

describe('VariableUrlInput', () => {
  beforeEach(() => {
    useEnvironmentStore.setState({ environments: [], activeEnvironmentId: null });
    useGlobalsStore.setState({ vars: { host: 'echo.dev' } });
  });

  it('edits the value and overlays {{variables}} with their status', () => {
    const { container } = render(<Harness initial="" />);
    const input = screen.getByRole('textbox', { name: 'WebSocket URL' });
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull();

    fireEvent.change(input, { target: { value: 'wss://{{host}}/{{missing}}' } });
    expect(input).toHaveValue('wss://{{host}}/{{missing}}');
    const overlay = container.querySelector('[aria-hidden="true"]');
    expect(overlay).toHaveTextContent('wss://{{host}}/{{missing}}');
    expect(input.className).toContain('text-transparent');
  });

  it('skips the overlay and flags the field when invalid', () => {
    const { container } = render(<Harness initial="{{host}}" invalid />);
    const input = screen.getByRole('textbox', { name: 'WebSocket URL' });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input.className).toContain('text-rose-400');
    expect(container.querySelector('.pointer-events-none')).toBeNull();
  });
});
