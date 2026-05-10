import { compileFromFile } from 'json-schema-to-typescript';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const SCHEMA = 'vendor/opencollection/v1.0.0/schema.json';
const OUT = 'src/lib/opencollection/spec-types.ts';

const banner = `/* eslint-disable */
/**
 * THIS FILE IS AUTO-GENERATED. DO NOT EDIT BY HAND.
 * Source: ${SCHEMA}
 * Regenerate with: npm run gen:opencollection-types
 */`;

const ts = await compileFromFile(SCHEMA, {
  bannerComment: banner,
  unreachableDefinitions: true,
  additionalProperties: false,
  declareExternallyReferenced: true,
  enableConstEnums: false,
});

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, ts);
console.log('Wrote', OUT, ts.split('\n').length, 'lines');
