'use client';

import { Button } from '@/components/ui/button';
import { Upload, FileText } from 'lucide-react';
import { toast } from 'sonner';
import { parseProtoFile } from '@/features/grpc/lib/grpcClient';
import { ProtoFileInfo, GrpcMethodType } from '@/types';

interface GrpcProtoUploaderProps {
  protoFile: File | null;
  onProtoFileChange: (file: File | null) => void;
  onProtoInfoChange: (info: ProtoFileInfo | null) => void;
  onServiceChange: (service: string) => void;
  onMethodChange: (method: string) => void;
  onMethodTypeChange: (methodType: GrpcMethodType) => void;
}

export default function GrpcProtoUploader({
  protoFile,
  onProtoFileChange,
  onProtoInfoChange,
  onServiceChange,
  onMethodChange,
  onMethodTypeChange,
}: GrpcProtoUploaderProps) {
  const handleProtoUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!file.name.endsWith('.proto')) {
      toast.error('Invalid file type', {
        description: 'Please upload a .proto file',
      });
      return;
    }

    onProtoFileChange(file);

    try {
      const content = await file.text();
      const parsed = parseProtoFile(content);
      onProtoInfoChange(parsed);

      // Auto-fill service if available
      if (parsed.services.length > 0) {
        const firstService = parsed.services[0];
        if (firstService) {
          onServiceChange(firstService.fullName);

          // Auto-fill first method if available
          if (firstService.methods.length > 0) {
            const firstMethod = firstService.methods[0];
            if (firstMethod) {
              onMethodChange(firstMethod.name);

              // Set method type based on streaming config
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
          }
        }

        toast.success('Proto file parsed', {
          description: `Found ${parsed.services.length} service(s) and ${Object.keys(parsed.messages).length} message type(s)`,
        });
      } else {
        toast.warning('No services found', {
          description: 'The proto file does not contain any service definitions',
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to parse proto file';
      toast.error('Proto parsing failed', {
        description: errorMessage,
      });
      onProtoInfoChange(null);
    }
  };

  return (
    <>
      <div className="relative">
        <input
          type="file"
          accept=".proto"
          onChange={handleProtoUpload}
          className="hidden"
          id="proto-upload"
        />
        <Button variant="outline" onClick={() => document.getElementById('proto-upload')?.click()}>
          <Upload className="mr-2 h-4 w-4" />
          {protoFile ? protoFile.name : 'Upload .proto'}
        </Button>
      </div>
    </>
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
      <div>
        Services: {protoInfo.services.map((s) => s.name).join(', ') || 'None'}
      </div>
      <div>Messages: {Object.keys(protoInfo.messages).join(', ') || 'None'}</div>
    </div>
  );
}
