import yaml from 'js-yaml';
import { assertBoundedDocument, openCollectionSchema, type OpenCollection } from './schemas';

export function parseOpenCollectionYAML(raw: string): OpenCollection {
  let doc: unknown;
  try {
    doc = yaml.load(raw, { schema: yaml.JSON_SCHEMA });
  } catch (err) {
    throw new Error(`Invalid YAML: ${(err as Error).message}`);
  }
  // Guard depth before the recursive schema validates the tree (see schemas.ts).
  assertBoundedDocument(doc);
  const result = openCollectionSchema.safeParse(doc);
  if (!result.success) {
    throw new Error(`Invalid OpenCollection: ${JSON.stringify(result.error.issues, null, 2)}`);
  }
  return result.data;
}

export function serializeOpenCollectionYAML(oc: OpenCollection): string {
  return yaml.dump(oc, {
    indent: 2,
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,
    quotingType: '"',
    forceQuotes: true,
  });
}
