import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ElectronAPI } from '../../../../electron/types/electron-api';
import { CaptureImportListener } from '../CaptureImportListener';

const disposeCaptureSubscription = vi.fn();
const capture = {
  onReceived: vi.fn(() => disposeCaptureSubscription),
};

vi.mock('@/lib/shared/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/shared/platform')>();
  return {
    ...actual,
    isElectron: () => true,
    getElectronAPI: () =>
      ({
        capture,
      }) as unknown as ElectronAPI,
  };
});

describe('CaptureImportListener', () => {
  it('disposes only its own capture subscription on unmount', () => {
    const { unmount } = render(<CaptureImportListener />);

    expect(capture.onReceived).toHaveBeenCalledOnce();
    unmount();

    expect(disposeCaptureSubscription).toHaveBeenCalledOnce();
  });
});
