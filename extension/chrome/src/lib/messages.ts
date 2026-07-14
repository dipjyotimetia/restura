/**
 * Typed message contract between the extension UI (popup / side panel) and the
 * background service worker. Validated with Zod so a malformed message from a
 * compromised page context can't drive the privileged debugger surface.
 */

import { captureSessionSchema } from '@shared/capture/schema';
import { z } from 'zod';

export const requestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('capture:start'), tabId: z.number().int() }),
  z.object({ type: z.literal('capture:stop') }),
  z.object({ type: z.literal('capture:get') }),
  z.object({ type: z.literal('capture:clear') }),
]);

export type CaptureRequest = z.infer<typeof requestSchema>;

export const captureStateSchema = z.object({
  capturing: z.boolean(),
  tabId: z.number().int().nullable(),
  session: captureSessionSchema.nullable(),
});

export type CaptureState = z.infer<typeof captureStateSchema>;
