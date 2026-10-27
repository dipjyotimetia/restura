import { describe, expect, it, vi } from 'vitest';
import { detectDroppedZip, readZipBytes } from '../import-dialog-data';

/** #1200 S5: an oversized .zip is refused by File.size before its bytes are loaded. */

function hugeZip(): { file: File; arrayBuffer: ReturnType<typeof vi.fn> } {
  const file = new File(['PK'], 'huge.zip', { type: 'application/zip' });
  Object.defineProperty(file, 'size', { value: 60 * 1024 * 1024 });
  const arrayBuffer = vi.fn(async () => new ArrayBuffer(2));
  Object.defineProperty(file, 'arrayBuffer', { value: arrayBuffer });
  return { file, arrayBuffer };
}

describe('zip size guard', () => {
  it('readZipBytes refuses an oversized archive without reading it', async () => {
    const { file, arrayBuffer } = hugeZip();
    await expect(readZipBytes(file)).rejects.toThrow(/too large/);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('detectDroppedZip refuses an oversized archive without reading it', async () => {
    const { file, arrayBuffer } = hugeZip();
    await expect(detectDroppedZip(file)).rejects.toThrow(/too large/);
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('a small archive is read', async () => {
    const file = new File(['PK'], 'ok.zip');
    Object.defineProperty(file, 'arrayBuffer', { value: async () => new ArrayBuffer(2) });
    expect((await readZipBytes(file)).byteLength).toBe(2);
  });
});
