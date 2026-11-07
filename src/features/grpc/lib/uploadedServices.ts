/**
 * Services + methods (with input/output message schemas) of a schema the user
 * uploaded (`.proto`, several `.proto` files, or a FileDescriptorSet), in the
 * same `ReflectionServiceInfo` shape reflection produces — so the method
 * picker and request-template generation treat both sources alike.
 */
import { descriptorsFromProtoFiles } from '@shared/protocol/grpc-registry';
import type { GrpcSchemaSnapshot, ReflectionServiceInfo } from '@/types';
import { uploadedDescriptors } from './protoUpload';
import { cacheMessageTypes, parseFileDescriptor } from './reflection/protoParser';
import { buildServiceInfo } from './reflection/serviceDiscovery';

/** Descriptors of an *uploaded* schema; reflection snapshots (no label) are not uploads. */
function uploadDescriptors(schema: GrpcSchemaSnapshot | undefined): string[] | null {
  if (!schema) return null;
  if (schema.kind === 'proto') {
    return descriptorsFromProtoFiles([{ path: schema.fileName, content: schema.text }]);
  }
  return uploadedDescriptors(schema)?.descriptors ?? null;
}

export function servicesFromUploadedSchema(
  schema: GrpcSchemaSnapshot | undefined
): ReflectionServiceInfo[] {
  try {
    const descriptors = uploadDescriptors(schema);
    if (!descriptors?.length) return [];
    // Cache every file's message types first: a service's input type may live
    // in an imported file that comes later in the set.
    const parsed = descriptors.map(parseFileDescriptor);
    for (const fd of parsed) cacheMessageTypes(fd);
    const services: ReflectionServiceInfo[] = [];
    for (const fd of parsed) {
      for (const svc of fd.service ?? []) {
        services.push({ ...buildServiceInfo(svc, fd.package || ''), descriptors });
      }
    }
    return services;
  } catch {
    // An unparsable upload was already reported by the uploader.
    return [];
  }
}
