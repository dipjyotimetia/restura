import { type BugReportDiagnostics, type BugReportPlatform, getRuntimeErrors } from './bug-report';
import { getAppVersion, getElectronAPI, getPlatform } from './platform';

export interface BugReportScreenshotResult {
  screenshot?: { imageDataUrl: string };
  error?: string;
}

function operatingSystem(): string {
  const platform = getPlatform();
  if (platform === 'darwin') return 'macOS';
  if (platform === 'win32') return 'Windows';
  if (platform === 'linux') return 'Linux';
  const ua = navigator.userAgent;
  if (ua.includes('Mac')) return 'macOS';
  if (ua.includes('Win')) return 'Windows';
  if (ua.includes('Linux')) return 'Linux';
  return 'Unknown';
}

function browser(): string {
  const ua = navigator.userAgent;
  if (ua.includes('Edg/')) return 'Microsoft Edge';
  if (ua.includes('Firefox/')) return 'Firefox';
  if (ua.includes('Chrome/')) return 'Chrome';
  if (ua.includes('Safari/')) return 'Safari';
  return 'Unknown';
}

export async function collectBugReportDiagnostics(): Promise<BugReportDiagnostics> {
  const electron = getElectronAPI();
  if (electron?.bugReport) {
    const diagnostics = await electron.bugReport.getDiagnostics();
    return { ...diagnostics, runtimeErrors: getRuntimeErrors() };
  }
  return {
    appVersion: await getAppVersion(),
    platform: 'web' satisfies BugReportPlatform,
    operatingSystem: operatingSystem(),
    browser: browser(),
    route: window.location.hash || window.location.pathname,
    capturedAt: new Date().toISOString(),
    runtimeErrors: getRuntimeErrors(),
  };
}

async function waitForVideoFrame(video: HTMLVideoElement): Promise<void> {
  if (typeof video.requestVideoFrameCallback === 'function') {
    await new Promise<void>((resolve) => video.requestVideoFrameCallback(() => resolve()));
    return;
  }
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return;
  await new Promise<void>((resolve) =>
    video.addEventListener('loadeddata', () => resolve(), { once: true })
  );
}

async function captureBrowserScreenshot(): Promise<string> {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error('Screenshot capture is not supported by this browser.');
  }
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  try {
    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    await waitForVideoFrame(video);
    const track = stream.getVideoTracks()[0];
    const settings = track?.getSettings();
    const width = settings?.width ?? video.videoWidth;
    const height = settings?.height ?? video.videoHeight;
    if (!width || !height) throw new Error('The selected screen could not be captured.');
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d')?.drawImage(video, 0, 0, width, height);
    return canvas.toDataURL('image/png');
  } finally {
    stream.getTracks().forEach((track) => track.stop());
  }
}

export async function captureBugReportScreenshot(): Promise<BugReportScreenshotResult> {
  try {
    const electron = getElectronAPI();
    if (electron?.bugReport) {
      const result = await electron.bugReport.captureScreenshot();
      return result.ok
        ? { screenshot: { imageDataUrl: result.imageDataUrl } }
        : { error: result.error };
    }
    return { screenshot: { imageDataUrl: await captureBrowserScreenshot() } };
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Screenshot capture failed.' };
  }
}

export async function copyBugReportScreenshot(imageDataUrl: string): Promise<void> {
  const electron = getElectronAPI();
  if (electron?.bugReport) {
    const result = await electron.bugReport.copyScreenshot(imageDataUrl);
    if (!result.ok) throw new Error(result.error);
    return;
  }
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    throw new Error('Image clipboard access is not supported by this browser.');
  }
  const response = await fetch(imageDataUrl);
  const image = await response.blob();
  await navigator.clipboard.write([new ClipboardItem({ [image.type]: image })]);
}
