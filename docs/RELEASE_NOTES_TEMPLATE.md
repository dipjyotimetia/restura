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

The generator omits empty groups and filters maintenance-only commits according
to `cliff.toml`. The app renders the generated groups as structured release
history; genuinely curated sections and older free-form bodies remain readable
as Markdown.
