import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureBugReportScreenshot } from '../bug-report-client';

const mediaDevicesDescriptor = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');

afterEach(() => {
  vi.restoreAllMocks();
  if (mediaDevicesDescriptor)
    Object.defineProperty(navigator, 'mediaDevices', mediaDevicesDescriptor);
  else Reflect.deleteProperty(navigator, 'mediaDevices');
});

describe('captureBugReportScreenshot', () => {
  it('waits for a rendered video frame before drawing the browser screenshot', async () => {
    const stop = vi.fn();
    const stream = {
      getVideoTracks: () => [{ getSettings: () => ({ width: 100, height: 50 }) }],
      getTracks: () => [{ stop }],
    } as unknown as MediaStream;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getDisplayMedia: vi.fn().mockResolvedValue(stream) },
    });

    let onFrame: VideoFrameRequestCallback | undefined;
    const video = {
      srcObject: null,
      muted: false,
      videoWidth: 100,
      videoHeight: 50,
      play: vi.fn().mockResolvedValue(undefined),
      requestVideoFrameCallback: vi.fn((callback: VideoFrameRequestCallback) => {
        onFrame = callback;
        return 1;
      }),
    } as unknown as HTMLVideoElement;
    const drawImage = vi.fn();
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn().mockReturnValue({ drawImage }),
      toDataURL: vi.fn().mockReturnValue('data:image/png;base64,c2NyZWVuc2hvdA=='),
    } as unknown as HTMLCanvasElement;
    const originalCreateElement = document.createElement.bind(document);
    const createElement = vi.spyOn(document, 'createElement');
    createElement.mockImplementation(((tagName: string) => {
      if (tagName === 'video') return video;
      if (tagName === 'canvas') return canvas;
      return originalCreateElement(tagName);
    }) as typeof document.createElement);

    const capture = captureBugReportScreenshot();
    await vi.waitFor(() => expect(video.requestVideoFrameCallback).toHaveBeenCalledOnce());
    expect(drawImage).not.toHaveBeenCalled();

    onFrame?.(0, {} as VideoFrameCallbackMetadata);

    await expect(capture).resolves.toEqual({
      screenshot: { imageDataUrl: 'data:image/png;base64,c2NyZWVuc2hvdA==' },
    });
    expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 100, 50);
    expect(stop).toHaveBeenCalledOnce();
  });
});
