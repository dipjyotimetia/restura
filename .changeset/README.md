# Changesets

This folder is used by [Changesets](https://github.com/changesets/changesets) to track user-facing
changes that need a CHANGELOG entry and version bump.

## When to add a changeset

Any PR that changes user-facing behavior — features, bug fixes, breaking changes, deprecations —
should ship with a changeset. Internal-only changes (refactors, test-only edits, CI tweaks,
dependency bumps that don't change behavior) don't need one.

## How to add a changeset

```bash
npm run changeset
```

The CLI will ask which packages changed and which bump level (`patch` / `minor` / `major`).
For now only `@restura/cli` is versioned via Changesets (the root `restura` app is `ignore`d
and versioned manually on release tags).

Commit the generated `.changeset/<random-slug>.md` file alongside your PR.

## How releases happen

When changesets land on `main`, the GitHub Action opens (or updates) a "Version Packages" PR
that bumps versions and rewrites `CHANGELOG.md`. Merging that PR cuts the release.
