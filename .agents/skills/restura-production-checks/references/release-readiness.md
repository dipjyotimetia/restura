# Release readiness

Require a green `merge-gate` from this repository's trusted CI workflow run on
a `main` push whose `head_sha` is the exact candidate commit. Confirm web/Worker,
optional Docker, CLI, and signed Electron surfaces use that propagated SHA and
the same version. Preserve tag-to-candidate verification, draft-release checks,
updater metadata, Sentry sourcemaps/smoke, platform signing, SBOMs, and
provenance attestations. Repair mode may rebuild only its documented surface
and must verify the tagged SHA rather than borrow evidence from current `main`.

Do not treat a local validator or a successful check from another commit as
release authorization.
