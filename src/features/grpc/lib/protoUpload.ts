/**
 * Turn a gRPC schema upload into a persisted `GrpcSchemaSnapshot` (#891).
 *
 *  - one `.proto`                → `{ kind: 'proto', fileName, text }` (text kept
 *                                   for display; WKT / bundled imports resolve)
 *  - several `.proto` / a folder  → compiled to per-file descriptors
 *  - a FileDescriptorSet          → split into per-file descriptors
 *    (`.binpb` / `.protoset` / `.desc` / `.pb`)
 *
 * Descriptor snapshots carry `fileName` (the upload label) so they keep
 * precedence over server reflection, like an uploaded `.proto`. They travel
 * through every harness exactly like a reflection snapshot.
 */
import {
  descriptorsFromDescriptorSet,
  descriptorsFromProtoFiles,
  listServices,
  type RegistryServiceInfo,
  registryFromDescriptors,
  registryFromProtoText,
} from '@shared/protocol/grpc-registry';
import type { GrpcSchemaSnapshot } from '@/types';

export const DESCRIPTOR_SET_EXTENSIONS = ['.binpb', '.protoset', '.desc', '.pb'] as const;
/** `accept` attribute for the schema file picker. */
export const PROTO_UPLOAD_ACCEPT = ['.proto', ...DESCRIPTOR_SET_EXTENSIONS].join(',');

/** The subset of `File` the loader needs (keeps it unit-testable). */
export interface ProtoUploadFile {
  name: string;
  /** Folder-upload path (`webkitRelativePath`); empty for plain picks. */
  webkitRelativePath?: string;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface ProtoUploadResult {
  schema: GrpcSchemaSnapshot;
  services: RegistryServiceInfo[];
}

const isProto = (name: string) => name.toLowerCase().endsWith('.proto');
const isDescriptorSet = (name: string) =>
  DESCRIPTOR_SET_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext));

/**
 * Load a schema upload. Throws an Error with a user-facing message for an
 * unsupported selection, a parse failure, or a missing import (named).
 */
export async function loadProtoUpload(
  files: readonly ProtoUploadFile[]
): Promise<ProtoUploadResult> {
  // A folder upload brings along unrelated files (READMEs, BUILD files, …).
  const protos = files.filter((f) => isProto(f.name));
  const sets = files.filter((f) => isDescriptorSet(f.name));

  if (protos.length === 0 && sets.length === 0) {
    throw new Error(
      `Upload .proto source(s) or a FileDescriptorSet (${DESCRIPTOR_SET_EXTENSIONS.join(', ')}).`
    );
  }
  if (sets.length > 0 && protos.length > 0) {
    throw new Error('Upload either .proto sources or one FileDescriptorSet, not both.');
  }

  if (sets.length > 0) {
    if (sets.length > 1) throw new Error('Upload one FileDescriptorSet at a time.');
    const set = sets[0] as ProtoUploadFile;
    const descriptors = descriptorsFromDescriptorSet(new Uint8Array(await set.arrayBuffer()));
    return {
      schema: { kind: 'descriptors', descriptors, fileName: set.name },
      services: listServices(registryFromDescriptors(descriptors)),
    };
  }

  if (protos.length === 1) {
    const file = protos[0] as ProtoUploadFile;
    const text = await file.text();
    return {
      schema: { kind: 'proto', fileName: file.name, text },
      services: listServices(registryFromProtoText(text, file.name)),
    };
  }

  const sources = await Promise.all(
    protos.map(async (f) => ({ path: f.webkitRelativePath || f.name, content: await f.text() }))
  );
  const descriptors = descriptorsFromProtoFiles(sources);
  const services = listServices(registryFromDescriptors(descriptors));
  // Label by the first file that declares a service (the one users think of).
  const lead =
    sources.find((s) => /^\s*service\s+\w+/m.test(s.content)) ?? (sources[0] as { path: string });
  const leadName = lead.path.slice(lead.path.lastIndexOf('/') + 1);
  return {
    schema: {
      kind: 'descriptors',
      descriptors,
      fileName: `${leadName} +${sources.length - 1}`,
    },
    services,
  };
}

/** The descriptors + label of a multi-file / FileDescriptorSet upload, else null. */
export function uploadedDescriptors(
  schema: GrpcSchemaSnapshot | undefined
): { descriptors: string[]; fileName: string } | null {
  return schema?.kind === 'descriptors' && schema.fileName
    ? { descriptors: schema.descriptors, fileName: schema.fileName }
    : null;
}
