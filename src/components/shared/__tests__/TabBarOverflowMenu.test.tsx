import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { RequestTab } from '@/types';
import { TabBarOverflowMenu } from '../TabBarOverflowMenu';

function tab(id: string, extra: Partial<RequestTab> = {}): RequestTab {
  return {
    id,
    request: { id: `r-${id}`, name: id, type: 'http' },
    ...extra,
  } as RequestTab;
}

describe('TabBarOverflowMenu', () => {
  it('lists every tab with its protocol, marks unsaved ones, and selects on click', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <TabBarOverflowMenu
        tabs={[
          tab('one'),
          tab('two', { isDirty: true, modeOverride: 'websocket' }),
          tab('three', { request: { id: 'r3', name: 'three', type: 'grpc' } as never }),
        ]}
        activeTabId="one"
        onSelect={onSelect}
        nameOf={(t) => `Tab ${t.id}`}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Show all tabs' }));
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual([
      'HTTPTab one',
      'WSTab two, unsaved changes',
      'gRPCTab three',
    ]);
    expect(items[0]).toHaveClass('bg-sp-active');
    expect(items[1]).not.toHaveClass('bg-sp-active');
    await user.click(items[2]!);
    expect(onSelect).toHaveBeenCalledWith('three');
  });
});
