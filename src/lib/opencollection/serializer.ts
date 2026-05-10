import yaml from 'js-yaml';
import { openCollectionSchema, type OpenCollection } from './schemas';

export function parseOpenCollectionYAML(raw: string): OpenCollection {
  let doc: unknown;
  try {
    doc = yaml.load(raw, { schema: yaml.JSON_SCHEMA });
  } catch (err) {
    throw new Error(`Invalid YAML: ${(err as Error).message}`);
  }
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
    forceQuotes: false,
  });
}
