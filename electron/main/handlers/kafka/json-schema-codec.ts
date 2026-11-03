// Confluent Schema Registry JSON Schema codec.
//
// Replaces the @kafkajs/confluent-schema-registry JSON path, which compiles
// every schema with a default (draft-07, strict-mode) Ajv: any schema using a
// `format` (date-time, email, uuid, …), a draft 2019-09 / 2020-12 `$schema`, or
// a keyword Ajv's strict mode does not know failed to compile, so neither
// produce nor consume worked for it.
//
// Wire body after magic byte + schema id is the UTF-8 JSON document. Produce
// validates against the schema; consume does not — a client that is used to
// inspect topics should show a non-conforming record rather than hide it.
// `format` is treated as an annotation (the JSON Schema 2019-09+ default and
// what the Confluent Python serializer does), so it never blocks a produce.

import type AjvCore from 'ajv';
import type { ValidateFunction } from 'ajv';

export interface JsonSchemaReference {
  name: string;
  schema: string;
}

export interface JsonSchemaCodec {
  encode(payload: unknown): Buffer;
  decode(body: Buffer): unknown;
}

type AjvClass = new (opts: Record<string, unknown>) => AjvCore;

function ajvClassFor(schema: unknown): AjvClass {
  const dialect =
    schema && typeof schema === 'object' ? (schema as { $schema?: unknown }).$schema : undefined;
  const id = typeof dialect === 'string' ? dialect : '';
  const load = (path: string): AjvClass => {
    const mod = require(path) as { default?: AjvClass } & AjvClass;
    return mod.default ?? mod;
  };
  if (id.includes('2020-12')) return load('ajv/dist/2020');
  if (id.includes('2019-09')) return load('ajv/dist/2019');
  return load('ajv');
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${what} is not valid JSON.`);
  }
}

export function buildJsonSchemaCodec(
  schemaText: string,
  references: readonly JsonSchemaReference[] = []
): JsonSchemaCodec {
  const schema = parseJson(schemaText, 'JSON Schema');
  const Ajv = ajvClassFor(schema);
  const ajv = new Ajv({
    strict: false,
    allErrors: true,
    validateFormats: false,
    // The registry already accepted the schema; meta-validation would only
    // reject dialects this Ajv build has no meta-schema for (draft-04/06).
    validateSchema: false,
    logger: false,
  });
  const added = new Set<string>();
  for (const ref of references) {
    if (added.has(ref.name)) continue;
    added.add(ref.name);
    const refSchema = parseJson(ref.schema, `Referenced JSON Schema "${ref.name}"`) as Record<
      string,
      unknown
    >;
    // Register under the reference name (what $ref uses); Ajv also indexes $id.
    const id = typeof refSchema.$id === 'string' ? refSchema.$id : undefined;
    ajv.addSchema(refSchema, id === ref.name ? undefined : ref.name);
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
    encode(payload) {
      if (!validate(payload)) {
        throw new Error(
          `Payload does not match the JSON Schema: ${ajv.errorsText(validate.errors?.slice(0, 10), { dataVar: 'value' })}`
        );
      }
      return Buffer.from(JSON.stringify(payload), 'utf8');
    },
    decode(body) {
      return JSON.parse(body.toString('utf8'));
    },
  };
}
