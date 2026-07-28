import { afterEach, describe, expect, it, vi } from 'vitest';
import { disposeRetainedMonacoModelsForOwner, retainMonacoModel } from '../monacoModelLifecycle';

function createModel() {
  return { dispose: vi.fn() };
}

describe('monacoModelLifecycle', () => {
  afterEach(() => {
    disposeRetainedMonacoModelsForOwner('tab-a');
    disposeRetainedMonacoModelsForOwner('tab-b');
  });

  it('disposes every model owned by a closed tab and leaves other tabs intact', () => {
    const body = createModel();
    const response = createModel();
    const otherTab = createModel();
    retainMonacoModel('tab-a', 'tab-a-body', body as never);
    retainMonacoModel('tab-a', 'tab-a-response', response as never);
    retainMonacoModel('tab-b', 'tab-b-body', otherTab as never);

    disposeRetainedMonacoModelsForOwner('tab-a');

    expect(body.dispose).toHaveBeenCalledOnce();
    expect(response.dispose).toHaveBeenCalledOnce();
    expect(otherTab.dispose).not.toHaveBeenCalled();
  });

  it('releases a stale model when the same owner path receives a replacement', () => {
    const stale = createModel();
    const replacement = createModel();
    retainMonacoModel('tab-a', 'tab-a-body', stale as never);
    retainMonacoModel('tab-a', 'tab-a-body', replacement as never);

    expect(stale.dispose).toHaveBeenCalledOnce();

    disposeRetainedMonacoModelsForOwner('tab-a');

    expect(replacement.dispose).toHaveBeenCalledOnce();
  });
});
