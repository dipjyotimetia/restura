import { AlertCircle } from 'lucide-react';
import { isElectron } from '@/lib/shared/platform';

const TLS_ERROR = /certificate|self.?signed|unable to (get|verify)|\btls\b|\bssl\b/i;

/** Reflection failed: the reason plus the most likely fix (CA, desktop app, or upload). */
export function GrpcReflectionErrorBanner({ error }: { error: string | undefined }) {
  return (
    <div className="mx-3 mt-2 p-2 rounded-sp-btn bg-red-500/10 text-destructive text-sp-11 font-mono flex items-start gap-1.5">
      <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
      <span className="break-words">
        Reflection failed: {error || 'Could not reach the gRPC server.'}
        {TLS_ERROR.test(error ?? '') &&
          ' — if the server uses a self-signed or private-CA certificate, add its CA in Settings → Certificates.'}
        {!isElectron() &&
          ' On the web, reflection works with gRPC-Web / Connect servers; a native gRPC (HTTP/2-only) server needs the Restura desktop app — or upload its .proto.'}
      </span>
    </div>
  );
}
