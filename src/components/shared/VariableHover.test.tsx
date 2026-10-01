import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VariableDetail } from '@/lib/shared/variableScopes';
import { useVariableHover } from './VariableHover';

const details = vi.hoisted(() => ({ list: [] as VariableDetail[] }));
vi.mock('@/hooks/useVariableStatus', () => ({ useVariableDetails: () => details.list }));

function Harness({ names }: { names: string[] }) {
  const hover = useVariableHover();
  return (
    <div data-testid="zone" onMouseMove={hover.onMouseMove} onMouseLeave={hover.onMouseLeave}>
      {names.map((n) => (
        <span key={n} data-var={n}>
          {`{{${n}}}`}
        </span>
      ))}
      {hover.card}
    </div>
  );
}

// jsdom has no layout: give each token a 10px-wide box laid out left to right.
function layOut() {
  document.querySelectorAll<HTMLElement>('[data-var]').forEach((el, i) => {
    el.getBoundingClientRect = () =>
      ({ left: i * 10, right: i * 10 + 10, top: 0, bottom: 10 }) as DOMRect;
  });
}

const hoverAt = (x: number) =>
  act(() => {
    fireEvent.mouseMove(screen.getByTestId('zone'), { clientX: x, clientY: 5 });
  });

describe('useVariableHover', () => {
  beforeEach(() => {
    details.list = [
      { name: 'host', value: 'api.dev', source: 'base-environment', secret: false },
      { name: 'token', value: 'shh', source: 'collection', secret: true },
      { name: 'handle', source: 'base-environment', secret: true },
      { name: 'fromScript', source: 'script', secret: false },
      { name: 'blank', value: '', source: 'global', secret: false },
    ];
  });

  const cases: Array<[string, RegExp]> = [
    ['host', /api\.dev/],
    ['token', /••••/],
    ['handle', /Stored secret/],
    ['fromScript', /Set by the pre-request script/],
    ['blank', /empty/],
    ['nope', /Not defined in any active scope/],
    ['$guid', /Dynamic value/],
    ['$bogus', /Unknown dynamic variable/],
  ];

  it.each(cases)('describes {{%s}}', (name, expected) => {
    render(<Harness names={[name]} />);
    layOut();
    hoverAt(5);
    expect(screen.getByRole('tooltip')).toHaveTextContent(expected);
    if (name === 'token') expect(screen.getByRole('tooltip')).not.toHaveTextContent('shh');
  });

  it('follows the pointer between tokens and hides off-token and on leave', () => {
    render(<Harness names={['host', 'token']} />);
    layOut();
    hoverAt(5);
    expect(screen.getByRole('tooltip')).toHaveTextContent('host');
    hoverAt(5);
    hoverAt(15);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Collection');
    hoverAt(50);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    hoverAt(5);
    act(() => {
      fireEvent.mouseLeave(screen.getByTestId('zone'));
    });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });
});
