/**
 * Capture data model — backend-agnostic.
 *
 * The single normalized shape that CDP events are reduced to before redaction
 * and export. Shared by the browser extension (which produces it from
 * `chrome.debugger` events) and the Electron desktop bridge (which consumes it).
 *
 * Types are inferred from the Zod schemas in `schema.ts` so the runtime
 * validator and the static types can never drift. Like the rest of `shared/`,
 * this module never imports from `src/`.
 */
import type { z } from 'zod';
import type {
  capturedBodySchema,
  capturedExchangeSchema,
  capturedFrameSchema,
  capturedGraphqlSchema,
  capturedHeaderSchema,
  capturedProtocolSchema,
  captureSessionSchema,
} from './schema';

export type CapturedProtocol = z.infer<typeof capturedProtocolSchema>;
export type CapturedHeader = z.infer<typeof capturedHeaderSchema>;
export type CapturedBody = z.infer<typeof capturedBodySchema>;
export type CapturedFrame = z.infer<typeof capturedFrameSchema>;
export type CapturedGraphql = z.infer<typeof capturedGraphqlSchema>;
export type CapturedExchange = z.infer<typeof capturedExchangeSchema>;
export type CaptureSession = z.infer<typeof captureSessionSchema>;
