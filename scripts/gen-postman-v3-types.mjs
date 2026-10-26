import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { compileFromFile } from 'json-schema-to-typescript';

const SCHEMA = 'vendor/postman/v3.0.0/schema.json';
const OUT = 'shared/collections/postman/v3-types.ts';

const banner = `/* biome-ignore-all lint */
/**
 * THIS FILE IS AUTO-GENERATED. DO NOT EDIT BY HAND.
 * Source: ${SCHEMA}
 * Regenerate with: npm run gen:postman-v3-types
 */`;

let ts = await compileFromFile(SCHEMA, {
  bannerComment: banner,
  unreachableDefinitions: true,
  additionalProperties: false,
  declareExternallyReferenced: true,
  enableConstEnums: false,
});

// Prefix every generated top-level declaration with `PostmanV3` so the Postman
// wire-spec names never collide with the app-domain types in `shared/types`.
// Word-boundaried so declarations and references rename together. The root
// schema compiles to `Collection`; it is renamed to `PostmanV3Collection`.
const names = [...ts.matchAll(/^export (?:interface|type) (\w+)/gm)].map((m) => m[1]);
const isComment = (line) => /^\s*(\/\*|\*|\/\/)/.test(line);
const renames = names
  .filter((n) => !n.startsWith('PostmanV3'))
  .map((n) => ({ re: new RegExp(`\\b${n}\\b`, 'g'), to: `PostmanV3${n}` }));
ts = ts
  .split('\n')
  .map((line) =>
    isComment(line) ? line : renames.reduce((l, { re, to }) => l.replace(re, () => to), line)
  )
  .join('\n');

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, ts);
console.log('Wrote', OUT, ts.split('\n').length, 'lines');
