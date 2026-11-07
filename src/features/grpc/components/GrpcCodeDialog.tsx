import { ProtocolCodeDialog } from '@/components/shared/ProtocolCodeDialog';
import { grpcCodeGenerators } from '@/lib/shared/codeGenerators/grpc';
import type { GrpcRequest } from '@/types';

/** "Code" for a gRPC call (unary or streaming): grpcurl / buf curl. */
export function GrpcCodeDialog({
  open,
  onOpenChange,
  request,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  request: GrpcRequest;
}) {
  return (
    <ProtocolCodeDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Generate gRPC command"
      description="Uses the Metadata tab entries as typed: {{variables}} stay unresolved and Auth-tab credentials are not included."
      generators={grpcCodeGenerators}
      options={{
        url: request.url,
        service: request.service,
        method: request.method,
        message: request.message,
        metadata: Object.fromEntries(
          request.metadata.filter((m) => m.enabled && m.key).map((m) => [m.key, m.value])
        ),
      }}
    />
  );
}
