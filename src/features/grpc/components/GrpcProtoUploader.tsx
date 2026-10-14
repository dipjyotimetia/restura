'use client';

import { FileText, FolderUp, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { loadProtoUpload, PROTO_UPLOAD_ACCEPT } from '@/features/grpc/lib/protoUpload';
import type { GrpcMethodType, GrpcSchemaSnapshot, ProtoFileInfo } from '@/types';

interface GrpcProtoUploaderProps {
  /** Label of the uploaded schema persisted on the request, if any. */
  protoFileName: string | null;
  /** Called with the schema snapshot to persist on the request. */
  onSchemaLoaded: (schema: GrpcSchemaSnapshot) => void;
  onServiceChange: (service: string) => void;
  onMethodChange: (method: string) => void;
  onMethodTypeChange: (methodType: GrpcMethodType) => void;
}

// Non-standard but supported by Chromium (web + Electron): pick a whole folder.
const FOLDER_PICKER_PROPS = { webkitdirectory: '' } as Record<string, string>;

/**
 * Schema upload: one `.proto`, several `.proto` files (imports resolved across
 * them), a whole folder, or a FileDescriptorSet (`.binpb` / `.protoset`).
 * google/protobuf well-known types resolve automatically.
 */
export default function GrpcProtoUploader({
  protoFileName,
  onSchemaLoaded,
  onServiceChange,
  onMethodChange,
  onMethodTypeChange,
}: GrpcProtoUploaderProps) {
  const handleUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    // Reset so re-picking the same file(s) fires onChange again.
    event.target.value = '';
    if (files.length === 0) return;

    try {
      const { schema, services } = await loadProtoUpload(files);
      onSchemaLoaded(schema);

      const firstService = services[0];
      if (!firstService) {
        toast.warning('No services found', {
          description: 'The uploaded schema does not contain any service definitions',
        });
        return;
      }
      onServiceChange(firstService.fullName);
      const firstMethod = firstService.methods[0];
      if (firstMethod) {
        onMethodChange(firstMethod.name);
        let methodType: GrpcMethodType = 'unary';
        if (firstMethod.clientStreaming && firstMethod.serverStreaming) {
          methodType = 'bidirectional-streaming';
        } else if (firstMethod.serverStreaming) {
          methodType = 'server-streaming';
        } else if (firstMethod.clientStreaming) {
          methodType = 'client-streaming';
        }
        onMethodTypeChange(methodType);
      }
      const methodCount = services.reduce((n, s) => n + s.methods.length, 0);
      toast.success('Schema loaded', {
        description: `Found ${services.length} service(s) and ${methodCount} method(s)`,
      });
    } catch (error) {
      toast.error('Proto parsing failed', {
        description: error instanceof Error ? error.message : 'Failed to parse the schema',
      });
    }
  };

  return (
    <div className="relative flex shrink-0 items-center gap-1">
      <input
        type="file"
        aria-label="Upload .proto file"
        accept={PROTO_UPLOAD_ACCEPT}
        multiple
        onChange={handleUpload}
        className="hidden"
        id="proto-upload"
      />
      <input
        type="file"
        aria-label="Upload a folder of .proto files"
        {...FOLDER_PICKER_PROPS}
        multiple
        onChange={handleUpload}
        className="hidden"
        id="proto-upload-folder"
      />
      <Button
        variant="outline"
        size="sm"
        onClick={() => document.getElementById('proto-upload')?.click()}
        title={
          protoFileName ??
          'Upload .proto file(s) — select every file the schema imports — or a FileDescriptorSet (.binpb / .protoset)'
        }
        className="h-8 shrink-0 text-sp-12 max-w-[180px]"
      >
        <Upload className="mr-1.5 h-3.5 w-3.5" />
        <span className="truncate">{protoFileName ?? 'Upload .proto'}</span>
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => document.getElementById('proto-upload-folder')?.click()}
        title="Upload a folder of .proto files (imports resolve within it)"
        aria-label="Upload proto folder"
        className="h-8 w-8 shrink-0 p-0"
      >
        <FolderUp className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

// Separate component for proto info display
export function GrpcProtoInfo({ protoInfo }: { protoInfo: ProtoFileInfo | null }) {
  if (!protoInfo) return null;

  return (
    <div className="bg-muted p-2 rounded text-xs space-y-1 border border-border">
      <div className="flex items-center gap-1 font-medium">
        <FileText className="h-3 w-3" />
        Proto File Info
      </div>
      <div>Package: {protoInfo.package || 'default'}</div>
      <div>Services: {protoInfo.services.map((s) => s.name).join(', ') || 'None'}</div>
      <div>Messages: {Object.keys(protoInfo.messages).join(', ') || 'None'}</div>
    </div>
  );
}
