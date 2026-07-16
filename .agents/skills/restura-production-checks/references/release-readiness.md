# Release readiness

Require a green `merge-gate` check run whose `head_sha` is the exact candidate
commit. Confirm web/Worker, optional Docker, CLI, and signed Electron surfaces
use the same version. Preserve draft-release verification, updater metadata,
Sentry sourcemaps/smoke, platform signing, SBOMs, and provenance attestations.
Repair mode may rebuild only its documented surface and must verify the tagged
SHA rather than borrow evidence from current `main`.

Do not treat a local validator or a successful check from another commit as
release authorization.
