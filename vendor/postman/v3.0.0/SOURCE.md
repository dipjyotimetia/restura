# Postman Collection Format v3.0.0 Schema Vendor

**Source URL:** https://schema.postman.com/collection/json/v3.0.0/draft-07/collection.json
**Fetched on:** 2026-10-26
**SHA-256 (schema.json):** e86a66089e4615b137a48eb935f409b995f3967f8321b56f182dceb4f2114a4b
**Draft:** JSON Schema draft-07, `$id` `v3-collection`. All `$ref`s are internal (`#/definitions/...`); nothing else is vendored.

## Regenerate / re-pin

```bash
curl -sSL https://schema.postman.com/collection/json/v3.0.0/draft-07/collection.json -o vendor/postman/v3.0.0/schema.json
shasum -a 256 vendor/postman/v3.0.0/schema.json   # update the SHA-256 line above
npm run gen:postman-v3-types                      # writes shared/collections/postman/v3-types.ts
```

CI runs `npm run verify:postman-v3-types` (regenerate + `git diff --exit-code`).

## License note

The `LICENSE` here is the Apache-2.0 text from `LICENSE.md` on the `develop` branch of
https://github.com/postmanlabs/schemas (fetched 2026-10-26). The schema file served from
schema.postman.com carries no license header itself; we assume it is the same artifact published
from that repository. Re-verify when re-pinning.

## Upstream quirk

`definitions.v3-folder.properties.$kind` is `const: "collection"` (not `"folder"`), so generated
types make folder items carry `$kind: 'collection'`. Importer code must discriminate folders
structurally (e.g. presence of `items`), not by `$kind`.
