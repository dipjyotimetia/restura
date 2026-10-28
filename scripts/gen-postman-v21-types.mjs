import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { compile } from 'json-schema-to-typescript';

const SCHEMA = 'vendor/postman/v2.1.0/schema.json';
const OUT = 'shared/collections/postman/v21-types.ts';

const banner = `/* biome-ignore-all lint */
/**
 * THIS FILE IS AUTO-GENERATED. DO NOT EDIT BY HAND.
 * Source: ${SCHEMA}
 * Regenerate with: npm run gen:postman-v21-types
 *
 * Types are STRICT (additionalProperties: false) even though the v2.1 schema is open.
 */`;

// The v2.1 schema carries human-readable `title`s ("Name of the collection",
// "HTTPS Schema Getpostman Com ...") that json-schema-to-typescript would turn
// into type names. Drop them so names derive from the definition keys instead
// (`Auth`, `Item`, `ItemGroup`, ...). The root has no key and is named below.
const schema = JSON.parse(await readFile(SCHEMA, 'utf8'));
const stripTitles = (node) => {
  if (Array.isArray(node)) {
    for (const v of node) stripTitles(v);
  } else if (node && typeof node === 'object') {
    // `title` as a schema keyword is a string; a property literally named
    // "title" would be an object schema, so it is left alone.
    if (typeof node.title === 'string') delete node.title;
    for (const v of Object.values(node)) stripTitles(v);
  }
};
stripTitles(schema);
// Description-only property schemas (no `type`, `$ref`, combinator, enum or
// shape) accept ANY JSON value in the schema — e.g. `variable.value`,
// `certificate.{key,cert}.src`, `description.version`. json-schema-to-typescript
// compiles them to `{ [k: string]: unknown }`, which rejects strings and
// numbers, so pin them to `unknown`. Only property schemas are touched (never
// a `properties` map itself).
const TYPE_KEYS = [
  'type',
  '$ref',
  'oneOf',
  'anyOf',
  'allOf',
  'enum',
  'const',
  'properties',
  'items',
];
const pinUntyped = (node) => {
  if (Array.isArray(node)) {
    for (const v of node) pinUntyped(v);
    return;
  }
  if (!node || typeof node !== 'object') return;
  if (node.properties && typeof node.properties === 'object') {
    for (const prop of Object.values(node.properties)) {
      if (prop && typeof prop === 'object' && !TYPE_KEYS.some((k) => k in prop)) {
        prop.tsType = 'unknown';
      }
    }
  }
  for (const v of Object.values(node)) pinUntyped(v);
};
pinUntyped(schema);
// Name each top-level definition after its key: `item-group` -> `ItemGroup`.
const pascal = (k) => k.replace(/(^|-)(\w)/g, (_, __, c) => c.toUpperCase());
for (const [key, def] of Object.entries(schema.definitions ?? {})) def.title = pascal(key);
schema.title = 'Collection';

let ts = await compile(schema, 'Collection', {
  bannerComment: banner,
  unreachableDefinitions: true,
  additionalProperties: false,
  declareExternallyReferenced: true,
  enableConstEnums: false,
  cwd: dirname(SCHEMA),
});

// Prefix every generated top-level declaration with `PostmanV21` so the Postman
// wire-spec names never collide with the app-domain types in `shared/types`.
// Word-boundaried so declarations and references rename together. The root
// compiles to `Collection`; it becomes `PostmanV21Collection`.
const names = [...ts.matchAll(/^export (?:interface|type) (\w+)/gm)].map((m) => m[1]);
const isComment = (line) => /^\s*(\/\*|\*|\/\/)/.test(line);
const renames = names
  .filter((n) => !n.startsWith('PostmanV21'))
  .map((n) => ({ re: new RegExp(`\\b${n}\\b`, 'g'), to: `PostmanV21${n}` }));
ts = ts
  .split('\n')
  .map((line) =>
    isComment(line) ? line : renames.reduce((l, { re, to }) => l.replace(re, () => to), line)
  )
  .join('\n');

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, ts);
console.log('Wrote', OUT, ts.split('\n').length, 'lines');
