/**
 * Backend-agnostic browser-capture core. Shared by the Chrome extension (which
 * produces captures from `chrome.debugger`) and the Electron desktop bridge
 * (which ingests them). Never imports from `src/`.
 */
export type {
  CaptureSession,
  CapturedBody,
  CapturedExchange,
  CapturedFrame,
  CapturedGraphql,
  CapturedHeader,
  CapturedProtocol,
} from './types';
export { classifyProtocol } from './protocol-classifier';
export type { ClassifyInput, ClassifyResult } from './protocol-classifier';
export { redactExchange } from './secret-extractor';
export type { RedactedSecret, RedactionResult } from './secret-extractor';
export { CdpNormalizer } from './cdp-normalizer';
export { sessionToHar } from './to-har';
export type { HarLog } from './to-har';
export { sessionToOpenCollection } from './to-opencollection';
export type { OpenCollectionDoc } from './to-opencollection';
