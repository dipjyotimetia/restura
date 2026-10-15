// gRPC schema drift detection (#937).
//
// A saved gRPC request carries a schema snapshot (reflection descriptors or an
// uploaded `.proto`). When the user reflects again, the fresh descriptor set is
// diffed against the saved one and every change is classified with
// buf-breaking-style rules (FIELD_NO_DELETE, FIELD_SAME_TYPE, RPC_NO_DELETE …).
//
// "Breaking" is judged from Restura's point of view: requests are authored as
// proto3 JSON, so a renamed field / json_name / enum value breaks a saved
// request body even though it is wire-compatible on the binary encoding.
//
// Both snapshot kinds are normalised through the shared descriptor registry
// (`grpc-registry.ts`), so a reflected set can be compared with an uploaded
// `.proto` and vice versa. Pure + backend-agnostic (renderer, CLI, Electron).
import {
  type DescEnum,
  type DescField,
  type DescMessage,
  type DescService,
  type Registry,
  ScalarType,
} from '@bufbuild/protobuf';
import { FeatureSet_FieldPresence } from '@bufbuild/protobuf/wkt';
import type { GrpcSchemaSnapshot } from '../types/grpc';
import { registryFromDescriptors, registryFromProtoText } from './grpc-registry';

export type GrpcSchemaChangeRule =
  // breaking
  | 'SERVICE_NO_DELETE'
  | 'RPC_NO_DELETE'
  | 'RPC_SAME_REQUEST_TYPE'
  | 'RPC_SAME_RESPONSE_TYPE'
  | 'RPC_SAME_CLIENT_STREAMING'
  | 'RPC_SAME_SERVER_STREAMING'
  | 'MESSAGE_NO_DELETE'
  | 'FIELD_NO_DELETE'
  | 'FIELD_SAME_NAME'
  | 'FIELD_SAME_JSON_NAME'
  | 'FIELD_SAME_TYPE'
  | 'FIELD_SAME_ONEOF'
  | 'FIELD_SAME_LABEL'
  | 'FIELD_REQUIRED_ADDED'
  | 'ENUM_NO_DELETE'
  | 'ENUM_VALUE_NO_DELETE'
  | 'ENUM_VALUE_SAME_NAME'
  // non-breaking
  | 'SERVICE_ADDED'
  | 'RPC_ADDED'
  | 'MESSAGE_ADDED'
  | 'FIELD_ADDED'
  | 'ENUM_ADDED'
  | 'ENUM_VALUE_ADDED';

export type GrpcSchemaChangeSeverity = 'breaking' | 'non-breaking';

export interface GrpcSchemaChange {
  rule: GrpcSchemaChangeRule;
  severity: GrpcSchemaChangeSeverity;
  /** Fully-qualified element the change applies to (e.g. `pkg.Msg.field`). */
  path: string;
  message: string;
}

export interface GrpcSchemaDiff {
  /** Breaking changes first, then by path. */
  changes: GrpcSchemaChange[];
  breaking: number;
  nonBreaking: number;
}

const NON_BREAKING: ReadonlySet<GrpcSchemaChangeRule> = new Set([
  'SERVICE_ADDED',
  'RPC_ADDED',
  'MESSAGE_ADDED',
  'FIELD_ADDED',
  'ENUM_ADDED',
  'ENUM_VALUE_ADDED',
]);

/** Build the descriptor registry for a snapshot. Throws on undecodable input. */
export function registryFromSnapshot(snapshot: GrpcSchemaSnapshot): Registry {
  return snapshot.kind === 'descriptors'
    ? registryFromDescriptors(snapshot.descriptors)
    : registryFromProtoText(snapshot.text);
}

interface Model {
  messages: Map<string, DescMessage>;
  enums: Map<string, DescEnum>;
  services: Map<string, DescService>;
}

function modelOf(registry: Registry): Model {
  const model: Model = { messages: new Map(), enums: new Map(), services: new Map() };
  for (const t of registry) {
    if (t.kind === 'message') model.messages.set(t.typeName, t);
    else if (t.kind === 'enum') model.enums.set(t.typeName, t);
    else if (t.kind === 'service') model.services.set(t.typeName, t);
  }
  return model;
}

const scalarName = (s: ScalarType): string => (ScalarType[s] ?? String(s)).toLowerCase();

/** Human-readable type signature; any difference is a FIELD_SAME_TYPE break. */
function fieldType(f: DescField): string {
  switch (f.fieldKind) {
    case 'scalar':
      return scalarName(f.scalar);
    case 'enum':
      return f.enum.typeName;
    case 'message':
      return f.message.typeName;
    case 'list': {
      const el =
        f.listKind === 'scalar'
          ? scalarName(f.scalar)
          : f.listKind === 'enum'
            ? f.enum.typeName
            : f.message.typeName;
      return `repeated ${el}`;
    }
    case 'map': {
      const v =
        f.mapKind === 'scalar'
          ? scalarName(f.scalar)
          : f.mapKind === 'enum'
            ? f.enum.typeName
            : f.message.typeName;
      return `map<${scalarName(f.mapKey)}, ${v}>`;
    }
  }
}

/** proto2 `required` (or Editions LEGACY_REQUIRED) — absence fails validation. */
const isRequired = (f: DescField): boolean =>
  f.presence === FeatureSet_FieldPresence.LEGACY_REQUIRED;

function sortedKeys<T>(a: Map<string, T>, b: Map<string, T>): string[] {
  return [...new Set([...a.keys(), ...b.keys()])].sort();
}

/** Diff two descriptor registries (old = saved snapshot, next = fresh reflection). */
export function diffGrpcRegistries(oldRegistry: Registry, nextRegistry: Registry): GrpcSchemaDiff {
  const before = modelOf(oldRegistry);
  const after = modelOf(nextRegistry);
  const changes: GrpcSchemaChange[] = [];
  const add = (rule: GrpcSchemaChangeRule, path: string, message: string) =>
    changes.push({
      rule,
      path,
      message,
      severity: NON_BREAKING.has(rule) ? 'non-breaking' : 'breaking',
    });

  for (const name of sortedKeys(before.services, after.services)) {
    const o = before.services.get(name);
    const n = after.services.get(name);
    if (!n) {
      add('SERVICE_NO_DELETE', name, `Service ${name} was removed`);
      continue;
    }
    if (!o) {
      add('SERVICE_ADDED', name, `Service ${name} was added`);
      continue;
    }
    const om = new Map(o.methods.map((m) => [m.name, m]));
    const nm = new Map(n.methods.map((m) => [m.name, m]));
    for (const mName of sortedKeys(om, nm)) {
      const path = `${name}.${mName}`;
      const a = om.get(mName);
      const b = nm.get(mName);
      if (!b) {
        add('RPC_NO_DELETE', path, `Method ${path} was removed or renamed`);
        continue;
      }
      if (!a) {
        add('RPC_ADDED', path, `Method ${path} was added`);
        continue;
      }
      if (a.input.typeName !== b.input.typeName) {
        add(
          'RPC_SAME_REQUEST_TYPE',
          path,
          `Request type changed: ${a.input.typeName} → ${b.input.typeName}`
        );
      }
      if (a.output.typeName !== b.output.typeName) {
        add(
          'RPC_SAME_RESPONSE_TYPE',
          path,
          `Response type changed: ${a.output.typeName} → ${b.output.typeName}`
        );
      }
      const aClient = a.methodKind === 'client_streaming' || a.methodKind === 'bidi_streaming';
      const bClient = b.methodKind === 'client_streaming' || b.methodKind === 'bidi_streaming';
      const aServer = a.methodKind === 'server_streaming' || a.methodKind === 'bidi_streaming';
      const bServer = b.methodKind === 'server_streaming' || b.methodKind === 'bidi_streaming';
      if (aClient !== bClient) {
        add(
          'RPC_SAME_CLIENT_STREAMING',
          path,
          `Client streaming ${bClient ? 'enabled' : 'disabled'}`
        );
      }
      if (aServer !== bServer) {
        add(
          'RPC_SAME_SERVER_STREAMING',
          path,
          `Server streaming ${bServer ? 'enabled' : 'disabled'}`
        );
      }
    }
  }

  for (const name of sortedKeys(before.messages, after.messages)) {
    const o = before.messages.get(name);
    const n = after.messages.get(name);
    if (!n) {
      add('MESSAGE_NO_DELETE', name, `Message ${name} was removed`);
      continue;
    }
    if (!o) {
      add('MESSAGE_ADDED', name, `Message ${name} was added`);
      continue;
    }
    const nByNumber = new Map(n.fields.map((f) => [f.number, f]));
    const oByNumber = new Map(o.fields.map((f) => [f.number, f]));
    for (const a of o.fields) {
      const path = `${name}.${a.name}`;
      const b = nByNumber.get(a.number);
      if (!b) {
        add('FIELD_NO_DELETE', path, `Field ${a.name} (#${a.number}) was removed`);
        continue;
      }
      if (a.name !== b.name) {
        add('FIELD_SAME_NAME', path, `Field #${a.number} renamed: ${a.name} → ${b.name}`);
      } else if (a.jsonName !== b.jsonName) {
        add('FIELD_SAME_JSON_NAME', path, `JSON name changed: ${a.jsonName} → ${b.jsonName}`);
      }
      const ta = fieldType(a);
      const tb = fieldType(b);
      if (ta !== tb) add('FIELD_SAME_TYPE', path, `Type changed: ${ta} → ${tb}`);
      const oneofA = a.oneof?.name;
      const oneofB = b.oneof?.name;
      if (oneofA !== oneofB) {
        add(
          'FIELD_SAME_ONEOF',
          path,
          `Oneof changed: ${oneofA ?? '(none)'} → ${oneofB ?? '(none)'}`
        );
      }
      // optional ↔ required (repeated is a cardinality change, already a FIELD_SAME_TYPE break).
      if (isRequired(a) !== isRequired(b)) {
        const label = (f: DescField) => (isRequired(f) ? 'required' : 'optional');
        add('FIELD_SAME_LABEL', path, `Label changed: ${label(a)} → ${label(b)}`);
      }
    }
    for (const b of n.fields) {
      if (!oByNumber.has(b.number)) {
        // A new required field breaks saved requests that cannot populate it.
        if (isRequired(b)) {
          add(
            'FIELD_REQUIRED_ADDED',
            `${name}.${b.name}`,
            `Required field ${b.name} (#${b.number}) was added`
          );
        } else {
          add('FIELD_ADDED', `${name}.${b.name}`, `Field ${b.name} (#${b.number}) was added`);
        }
      }
    }
  }

  for (const name of sortedKeys(before.enums, after.enums)) {
    const o = before.enums.get(name);
    const n = after.enums.get(name);
    if (!n) {
      add('ENUM_NO_DELETE', name, `Enum ${name} was removed`);
      continue;
    }
    if (!o) {
      add('ENUM_ADDED', name, `Enum ${name} was added`);
      continue;
    }
    // `allow_alias` lets several names share one number, so index every name
    // per number — a single-value map would pair an alias with its sibling and
    // report a false rename.
    const namesByNumber = (e: DescEnum): Map<number, string[]> => {
      const m = new Map<number, string[]>();
      for (const v of e.values) m.set(v.number, [...(m.get(v.number) ?? []), v.name]);
      return m;
    };
    const nByNumber = namesByNumber(n);
    const oByNumber = namesByNumber(o);
    for (const a of o.values) {
      const names = nByNumber.get(a.number);
      const path = `${name}.${a.name}`;
      if (!names)
        add('ENUM_VALUE_NO_DELETE', path, `Enum value ${a.name} (${a.number}) was removed`);
      else if (!names.includes(a.name)) {
        add(
          'ENUM_VALUE_SAME_NAME',
          path,
          `Enum value ${a.number} renamed: ${a.name} → ${names.join(' / ')}`
        );
      }
    }
    for (const b of n.values) {
      if (!oByNumber.has(b.number)) {
        add(
          'ENUM_VALUE_ADDED',
          `${name}.${b.name}`,
          `Enum value ${b.name} (${b.number}) was added`
        );
      }
    }
  }

  changes.sort((x, y) =>
    x.severity === y.severity ? x.path.localeCompare(y.path) : x.severity === 'breaking' ? -1 : 1
  );
  const breaking = changes.filter((c) => c.severity === 'breaking').length;
  return { changes, breaking, nonBreaking: changes.length - breaking };
}

/** Diff two persisted snapshots. Throws when either cannot be decoded. */
export function diffGrpcSnapshots(
  oldSnapshot: GrpcSchemaSnapshot,
  nextSnapshot: GrpcSchemaSnapshot
): GrpcSchemaDiff {
  return diffGrpcRegistries(registryFromSnapshot(oldSnapshot), registryFromSnapshot(nextSnapshot));
}
