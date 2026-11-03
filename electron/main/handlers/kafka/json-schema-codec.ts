// Confluent Schema Registry JSON Schema codec.
//
// Replaces the @kafkajs/confluent-schema-registry JSON path, which compiles
// every schema with a default (draft-07, strict-mode) Ajv: any schema using a
// `format` (date-time, email, …), a draft-04/06/2019-09/2020-12 `$schema`, or a
// keyword Ajv's strict mode does not know failed to compile, so neither
// produce nor consume worked for it.
//
// Validation is Ajv, built for the schema's dialect (`$schema`): draft-04
// (ajv-draft-04), draft-06/07 (Ajv), 2019-09 and 2020-12 (ajv/dist/*).
// `format` is an annotation (the 2019-09+ default and what the Confluent Python
// serializer does), so it never blocks a produce.
//
// Wire body after magic byte + schema id is the UTF-8 JSON document. Produce
// validates and then writes the user's JSON text as-is, and consume returns
// the record's text as-is, so integers beyond 2^53 (or any other number
// formatting) survive in both directions — JSON.parse/stringify would round
// them. Consume does not validate: a client used to inspect topics should show
// a non-conforming record rather than hide it.

import type AjvCore from 'ajv';
import type { ValidateFunction } from 'ajv';
import type { SchemaReference } from './schema-types';

export interface JsonSchemaCodec {
  encode(json: string): Buffer;
  decode(body: Buffer): unknown;
}

type AjvClass = new (opts: Record<string, unknown>) => AjvCore;

function load(path: string): AjvClass {
  const mod = require(path) as { default?: AjvClass } & AjvClass;
  return mod.default ?? mod;
}

function ajvFor(schema: unknown): AjvCore {
  const dialect =
    schema && typeof schema === 'object' ? (schema as { $schema?: unknown }).$schema : undefined;
  const id = typeof dialect === 'string' ? dialect : '';
  const opts = { strict: false, allErrors: true, validateFormats: false, logger: false };
  if (id.includes('2020-12')) return new (load('ajv/dist/2020'))(opts);
  if (id.includes('2019-09')) return new (load('ajv/dist/2019'))(opts);
  if (id.includes('draft-04')) return new (load('ajv-draft-04'))(opts);
  const ajv = new (load('ajv'))(opts);
  if (id.includes('draft-06')) {
    ajv.addMetaSchema(require('ajv/dist/refs/json-schema-draft-06.json'));
  }
  return ajv;
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${what} is not valid JSON.`);
  }
}

function schemaId(schema: unknown): string | undefined {
  if (!schema || typeof schema !== 'object') return undefined;
  const s = schema as { $id?: unknown; id?: unknown };
  const id = typeof s.$id === 'string' ? s.$id : typeof s.id === 'string' ? s.id : undefined;
  return id && URL.canParse(id) ? id : undefined;
}

export function buildJsonSchemaCodec(
  schemaText: string,
  references: readonly SchemaReference[] = []
): JsonSchemaCodec {
  const schema = parseJson(schemaText, 'JSON Schema');
  const ajv = ajvFor(schema);
  const base = schemaId(schema);
  const added = new Set<string>();
  for (const ref of references) {
    if (added.has(ref.name)) continue;
    added.add(ref.name);
    const refSchema = parseJson(ref.schema, `Referenced JSON Schema "${ref.name}"`);
    const own = schemaId(refSchema);
    // `$ref` uses the reference name; relative names resolve against the
    // main schema's $id, so register that absolute URL too.
    const keys = new Set([ref.name]);
    if (base && !URL.canParse(ref.name)) keys.add(new URL(ref.name, base).href);
    if (own) {
      // Ajv indexes the schema under its own absolute id; alias the other keys to it.
      keys.delete(own);
      ajv.addSchema(refSchema as Record<string, unknown>);
      for (const key of keys) ajv.addSchema({ $ref: own }, key);
    } else {
      for (const key of keys)
        ajv.addSchema(structuredClone(refSchema) as Record<string, unknown>, key);
    }
  }
  let validate: ValidateFunction;
  try {
    validate = ajv.compile(schema as Record<string, unknown>);
  } catch (err) {
    throw new Error(
      `JSON Schema could not be compiled: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return {
    encode(json) {
      const payload = parseJson(json, 'Payload');
      if (!validate(payload)) {
        throw new Error(
          `Payload does not match the JSON Schema: ${ajv.errorsText(validate.errors?.slice(0, 10), { dataVar: 'value' })}`
        );
      }
      return Buffer.from(json.trim(), 'utf8');
    },
    decode(body) {
      const text = body.toString('utf8');
      JSON.parse(text); // not JSON → let the caller fall back to raw bytes
      return text;
    },
  };
}
