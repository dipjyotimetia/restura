# Renderer layer

Keep feature code under `src/features/<feature>/` and cross-feature composition
at routes or shared components. Use `@/` imports. Executors choose IPC versus
HTTP with `isElectron()` rather than build-time environment checks. Persisted
Zustand state must have a Zod validator and use Dexie on web or secure storage
on desktop; do not introduce localStorage. Secret handles remain opaque.

Test pure behavior beside the feature, store migration/validation at the
boundary, and drive visible changes in a real browser with zero new console
errors.
