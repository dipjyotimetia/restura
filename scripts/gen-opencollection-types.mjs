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

let ts = await compileFromFile(SCHEMA, {
  bannerComment: banner,
  unreachableDefinitions: true,
  additionalProperties: false,
  declareExternallyReferenced: true,
  enableConstEnums: false,
});

// Prefix the generated type names that collide with hand-written app-domain
// types in `src/types` (the OpenCollection wire spec vs. the app's domain
// model). This module is self-contained and currently unimported, so the
// prefix is local to this file; it keeps the generated names from shadowing
// the domain model in duplicate-type audits. Word-boundaried so declarations
// and references rename together (these names appear only in types/JSDoc here,
// never as runtime string values).
const COLLIDING_WITH_APP_TYPES = [
  'HttpRequest',
  'GrpcRequest',
  'WebSocketMessage',
  'RequestSettings',
  'Environment',
];
for (const name of COLLIDING_WITH_APP_TYPES) {
  ts = ts.replace(new RegExp(`\\b${name}\\b`, 'g'), `Oc${name}`);
}

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, ts);
console.log('Wrote', OUT, ts.split('\n').length, 'lines');
