# OpenCollection Schema Vendor

**Source:** https://github.com/opencollection-dev/opencollection
**Path:** `packages/oc-schema/src/opencollection.schema.json`
**Pinned commit:** 6a22bc36f5d72bb285c8cf00b5803ac66f05eecb
**Vendored on:** 2026-05-10
**Spec version:** v1.0.0

The pinned commit SHA above was resolved from upstream's `main` branch HEAD at vendoring time.

## Re-pin

To re-pin to a newer upstream commit:

```bash
# Re-pin to a newer upstream commit
COMMIT_SHA=$(gh api repos/opencollection-dev/opencollection/commits/main --jq '.sha')
gh api repos/opencollection-dev/opencollection/contents/packages/oc-schema/src/opencollection.schema.json --jq '.content' | base64 -d > vendor/opencollection/v1.0.0/schema.json
# Then update the "Pinned commit" line in this file with the new $COMMIT_SHA value.
```

After re-pinning, run `npm run gen:opencollection-types` to regenerate the TS types
(this script is added once `src/lib/opencollection/` lands — it is part of the
project's lifecycle, not a precondition at this commit) and then `npm run validate`
for the full check.

## License note

Upstream has **no top-level `LICENSE` file** at the pinned commit (we probed `LICENSE`,
`LICENSE.md`, `LICENSE.txt`, `license`, `LICENCE`, and `COPYING` — all returned 404).
However, `packages/oc-schema/package.json` declares `"license": "MIT"`. Because the
repository ships no actual license text, we do not assume MIT and instead write
`NO_LICENSE_FILE_AT_UPSTREAM` into `LICENSE` here as a marker. Re-check upstream when
re-pinning — if a real LICENSE file lands, replace the placeholder with the verbatim
upstream text.
