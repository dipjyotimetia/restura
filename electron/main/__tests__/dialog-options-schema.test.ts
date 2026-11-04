import { describe, expect, it } from 'vitest';
import { DialogOptionsSchema } from '../ipc/ipc-validators';

describe('DialogOptionsSchema', () => {
  it('keeps the dialog title the renderer passes (openFileDialog / saveFileDialog)', () => {
    const parsed = DialogOptionsSchema.parse({ title: 'Export collection', defaultPath: 'a.json' });
    expect(parsed).toEqual({ title: 'Export collection', defaultPath: 'a.json' });
  });

  it('rejects a non-string or oversized title', () => {
    expect(DialogOptionsSchema.safeParse({ title: 42 }).success).toBe(false);
    expect(DialogOptionsSchema.safeParse({ title: 'x'.repeat(1025) }).success).toBe(false);
  });
});
