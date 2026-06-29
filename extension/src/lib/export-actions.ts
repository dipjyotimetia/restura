/**
 * Standalone export sinks for a capture session. Both run entirely in the
 * extension (no Restura instance required) using the shared capture core.
 */
import { sessionToHar } from '@shared/capture/to-har';
import { sessionToOpenCollection } from '@shared/capture/to-opencollection';
import type { CaptureSession } from '@shared/capture/types';

function download(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // Defer revoke: revoking in the same tick as the click can truncate the
  // download before the browser has read the blob.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function exportOpenCollection(session: CaptureSession): void {
  const doc = sessionToOpenCollection(session, { name: 'Captured Session' });
  download('captured.opencollection.json', JSON.stringify(doc, null, 2), 'application/json');
}

export function exportHar(session: CaptureSession): void {
  download('captured.har', JSON.stringify(sessionToHar(session), null, 2), 'application/json');
}
