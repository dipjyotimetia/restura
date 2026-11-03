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
// validates and writes compact JSON re-printed without rounding, and consume
// returns the record's text as-is, so integers beyond 2^53 survive in both
// directions — JSON.parse/stringify would round them. Consume does not validate: a client used to inspect topics should show
// a non-conforming record rather than hide it.

import { reformatJsonLossless } from '@shared/text/lossless-json';
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

function withoutIdKeyword(ajv: AjvCore): AjvCore {
  ajv.removeKeyword('id');
  return ajv;
}

function dialectOf(schema: unknown): string {
  const dialect =
    schema && typeof schema === 'object' ? (schema as { $schema?: unknown }).$schema : undefined;
  return typeof dialect === 'string' ? dialect : '';
}

function ajvFor(dialect: string): AjvCore {
  const opts = {
    strict: false,
    allErrors: true,
    validateFormats: false,
    // The registry already accepted the schema. Meta-validation would only
    // reject dialect URL spellings this build has no meta-schema for
    // (https://…draft-07…, custom metas) and references in another dialect.
    validateSchema: false,
    logger: false,
  };
  if (dialect.includes('2020-12')) return withoutIdKeyword(new (load('ajv/dist/2020'))(opts));
  if (dialect.includes('2019-09')) return withoutIdKeyword(new (load('ajv/dist/2019'))(opts));
  if (dialect.includes('draft-04')) return new (load('ajv-draft-04'))(opts);
  // Outside draft-04 `id` is not an identifier, just an unknown keyword, but
  // Ajv refuses it outright; let non-strict mode ignore it like other unknowns.
  return withoutIdKeyword(new (load('ajv'))(opts));
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${what} is not valid JSON.`);
  }
}

/** The schema's absolute identifier: `$id`, or `id` in draft-04 only. */
function schemaId(schema: unknown, inheritedDialect: string): string | undefined {
  if (!schema || typeof schema !== 'object') return undefined;
  const s = schema as { $id?: unknown; id?: unknown };
  const dialect = dialectOf(schema) || inheritedDialect;
  const id =
    typeof s.$id === 'string'
      ? s.$id
      : dialect.includes('draft-04') && typeof s.id === 'string'
        ? s.id
        : undefined;
  return id && URL.canParse(id) ? id : undefined;
}

/** Names a `$ref` to this reference may use. */
function referenceKeys(name: string, base: string | undefined): Set<string> {
  const keys = new Set([name]);
  if (!URL.canParse(name)) {
    // Redpanda stores reference $refs root-relative ("other.json" → "/other.json").
    keys.add(name.startsWith('/') ? name.slice(1) : `/${name}`);
    // Relative names resolve against the main schema's $id.
    if (base) keys.add(new URL(name, base).href);
  }
  return keys;
}

export function buildJsonSchemaCodec(
  schemaText: string,
  references: readonly SchemaReference[] = []
): JsonSchemaCodec {
  const schema = parseJson(schemaText, 'JSON Schema');
  const dialect = dialectOf(schema);
  const ajv = ajvFor(dialect);
  const base = schemaId(schema, dialect);
  const registeredKeys = new Set<string>();
  const registeredIds = new Set<string>();
  let validate: ValidateFunction;
  try {
    for (const ref of references) {
      const refSchema = parseJson(ref.schema, `Referenced JSON Schema "${ref.name}"`);
      const own = schemaId(refSchema, dialect);
      const keys = [...referenceKeys(ref.name, base)].filter(
        (k) => k !== own && !registeredKeys.has(k)
      );
      if (own) {
        // Ajv indexes a schema under its own id; alias every other name to it.
        if (!registeredIds.has(own)) {
          ajv.addSchema(refSchema as Record<string, unknown>);
          registeredIds.add(own);
        }
        for (const key of keys) ajv.addSchema({ $ref: own }, key);
      } else {
        for (const key of keys) {
          ajv.addSchema(structuredClone(refSchema) as Record<string, unknown>, key);
        }
      }
      for (const key of keys) registeredKeys.add(key);
    }
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
      // Compact JSON, keeping integer literals beyond 2^53 exactly. (Validation
      // sees the parsed value, where such integers are rounded.)
      return Buffer.from(reformatJsonLossless(json), 'utf8');
    },
    decode(body) {
      const text = body.toString('utf8');
      JSON.parse(text); // not JSON → let the caller fall back to raw bytes
      return text;
    },
  };
}
