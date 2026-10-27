# Postman Collection Format v2.1.0 Schema Vendor

**Source URL:** https://schema.postman.com/collection/json/v2.1.0/draft-07/collection.json
**Fetched on:** 2026-10-27
**SHA-256 (schema.json):** 90a81dbfd6aae2b1605f5d987d08a2bdab51a68c2a027ecffc52b11656ef7d8b
**Draft:** JSON Schema draft-07, `$id` `https://schema.getpostman.com/json/draft-07/collection/v2.1.0/`. All `$ref`s are internal (`#/definitions/...`); nothing else is vendored.

## Regenerate / re-pin

```bash
curl -sSL https://schema.postman.com/collection/json/v2.1.0/draft-07/collection.json -o vendor/postman/v2.1.0/schema.json
shasum -a 256 vendor/postman/v2.1.0/schema.json   # update the SHA-256 line above
npm run gen:postman-v21-types                     # writes shared/collections/postman/v21-types.ts
```

CI runs `npm run verify:postman-v21-types` (regenerate + `git diff --exit-code`).

## Strict generated types

Unlike v3, the v2.1 schema does not set `additionalProperties: false`. The generator passes
`additionalProperties: false` anyway, so `shared/collections/postman/v21-types.ts` is STRICT. These
types describe what Restura emits. The importer stays lenient and runtime-guarded.

The generator strips the schema's human-readable `title`s and re-titles each definition after its
key (`item-group` -> `ItemGroup`) so type names are stable. Every declaration is prefixed
`PostmanV21`; the root is `PostmanV21Collection`.

## License note

The `LICENSE` here is the Apache-2.0 text from `LICENSE.md` on the `develop` branch of
https://github.com/postmanlabs/schemas (same text as `vendor/postman/v3.0.0/LICENSE`). The schema
file served from schema.postman.com carries no license header itself; we assume it is the same
artifact published from that repository. Re-verify when re-pinning.

## Upstream quirks

Real Postman exports also emit values the schema does not allow: `type: "secret"` variables
(schema enum: `string`, `boolean`, `any`, `number`) and `jwt` / `asap` / `akamai` auth types
(schema enum: `apikey`, `awsv4`, `basic`, `bearer`, `digest`, `edgegrid`, `hawk`, `noauth`,
`oauth1`, `oauth2`, `ntlm`). The importer must tolerate these even though the generated types
reject them.
