import { act, render } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useRevealActiveCollection } from '../useRevealActiveCollection';

function Tree({ makeTabStop }: { makeTabStop: (row: HTMLElement) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useRevealActiveCollection(ref, makeTabStop);
  return (
    <div ref={ref} role="tree">
      <div role="treeitem" data-tree-row data-item-type="collection" data-item-id="c1" tabIndex={0}>
        First
      </div>
      <div
        role="treeitem"
        data-tree-row
        data-item-type="collection"
        data-item-id="c2"
        tabIndex={-1}
      >
        Imported
      </div>
    </div>
  );
}

describe('useRevealActiveCollection', () => {
  afterEach(() => {
    useCollectionStore.setState({ activeCollectionId: null });
  });

  it('scrolls the newly active collection into view and gives it the tab stop', () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const makeTabStop = vi.fn();
    const { getByText } = render(<Tree makeTabStop={makeTabStop} />);
    expect(makeTabStop).not.toHaveBeenCalled();

    act(() => {
      useCollectionStore.getState().setActiveCollection('c2');
    });

    expect(makeTabStop).toHaveBeenCalledWith(getByText('Imported'));
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
  });
});
