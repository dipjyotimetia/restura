# Release Notes Template

GitHub Release bodies are Restura's canonical release notes. The release
workflow generates a draft from conventional commits and publishes that body
without a manual editorial step once every release gate succeeds. Keep the
generated body free of editorial placeholders that require pre-publication
replacement.

```md
## 1.7.0 — 2026-07-16

## Added

- Add a new capability ([`abcdef0`](https://github.com/dipjyotimetia/restura/commit/abcdef0))

## Changed

- Improve an existing workflow ([`1234567`](https://github.com/dipjyotimetia/restura/commit/1234567))

## Fixed

- Correct a user-visible regression ([`7654321`](https://github.com/dipjyotimetia/restura/commit/7654321))
```

## How the app reads release notes

The in-app release-notes panel reads a static feed, not the GitHub API (anonymous
API calls are limited to 60 an hour per IP, shared by a whole network).
`.github/workflows/release-feed.yml` runs after each release is published, builds
`releases.json` from the Releases list with `scripts/release-feed.mjs`, and deploys
it to the `restura-releases` Cloudflare Pages project. The app
(`src/lib/shared/release-notes.ts`) falls back to `api.github.com` if the feed is
unreachable or invalid. Edit a published release body on GitHub, then dispatch
"Release feed" to republish it.

The generator omits empty groups and filters maintenance-only commits according
to `cliff.toml`. The app renders the generated groups as structured release
history; genuinely curated sections and older free-form bodies remain readable
as Markdown.

## Verify this release

Each release's notes should end with this block. The macOS identity comment is
an HTML comment, so it does not render and does not block publication:

```md
### Verify this release

- macOS: signed with a "Developer ID Application" certificate and notarized.
  <!-- maintainer: fill in "Developer ID Application: NAME (TEAMID)" once -->
- Windows: not code-signed yet. Verify with the attestation below.
- Any installer: `gh attestation verify <file> --repo dipjyotimetia/restura`

Full instructions (Docker, npm, SBOM, extensions):
https://github.com/dipjyotimetia/restura/blob/main/SECURITY.md#verifying-downloads
```
