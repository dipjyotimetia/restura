// TODO(plan: 2026-05-08-foundation-shared-protocol, Task 11):
// Delete this shim once all worker imports are migrated to @shared/protocol/url-validation directly.
export {
  validateURL,
  isPrivateAddress,
  type URLValidationResult,
  type URLValidationOptions,
} from '@shared/protocol/url-validation';
