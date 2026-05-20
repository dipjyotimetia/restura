import { AlertCircle, Laptop } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { TextField } from '@/components/ui/spatial';
import type { ReflectionMethodInfo, ReflectionServiceInfo } from '@/types';
import { isElectron } from '@/lib/shared/platform';
import { cn } from '@/lib/shared/utils';

interface FieldValidation {
  valid: boolean;
  error?: string | undefined;
}

interface GrpcMethodSelectorProps {
  /** Reflection-discovered services. Empty/undefined → fall back to free-text inputs. */
  services: ReflectionServiceInfo[] | undefined;
  selectedService: ReflectionServiceInfo | null;
  selectedMethod: ReflectionMethodInfo | null;
  /** Free-text values (used when reflection isn't available). */
  serviceValue: string;
  methodValue: string;
  serviceValidation: FieldValidation;
  methodValidation: FieldValidation;
  onSelectService: (service: ReflectionServiceInfo) => void;
  onSelectMethod: (method: ReflectionMethodInfo) => void;
  onServiceTextChange: (value: string) => void;
  onMethodTextChange: (value: string) => void;
}

const streamingLabel = (method: ReflectionMethodInfo): string | null => {
  if (method.clientStreaming && method.serverStreaming) return '(bidi)';
  if (method.serverStreaming) return '(server stream)';
  if (method.clientStreaming) return '(client stream)';
  return null;
};

/**
 * Client-streaming and bidi rely on a duplex channel that the Cloudflare
 * Worker's HTTP/1 transport can't expose. Surface a clear hint in the picker
 * so users know the method is only callable from the desktop app.
 *
 * Server-streaming alone works fine through the Worker (server-sent frames
 * map onto a single chunked HTTP response), so it stays available on web.
 */
const requiresDesktop = (method: ReflectionMethodInfo): boolean =>
  method.clientStreaming === true && !isElectron();

/**
 * Service + method dropdowns for the gRPC request builder.
 *
 * When reflection has discovered services, shows two dependent <Select>s
 * (service → method). Otherwise, falls back to free-text Spatial TextFields
 * so the user can type a service/method that isn't reflectable.
 */
export function GrpcMethodSelector({
  services,
  selectedService,
  selectedMethod,
  serviceValue,
  methodValue,
  serviceValidation,
  methodValidation,
  onSelectService,
  onSelectMethod,
  onServiceTextChange,
  onMethodTextChange,
}: GrpcMethodSelectorProps) {
  const reflectionServices = services?.filter((s) => s.fullName) ?? [];
  const hasReflectionServices = reflectionServices.length > 0;
  const reflectionMethods =
    selectedService?.methods.filter((m) => m.name) ?? [];
  const hasReflectionMethods = reflectionMethods.length > 0;

  return (
    <>
      <div className="flex-1 relative">
        {hasReflectionServices ? (
          <Select
            value={selectedService?.fullName || ''}
            onValueChange={(value) => {
              const service = reflectionServices.find((s) => s.fullName === value);
              if (service) onSelectService(service);
            }}
          >
            <SelectTrigger
              className={cn(
                'h-8 font-mono text-sp-12 bg-sp-surface-lo border-sp-line text-sp-text',
                !serviceValidation.valid && 'border-red-500'
              )}
            >
              <SelectValue placeholder="Select service" />
            </SelectTrigger>
            <SelectContent>
              {reflectionServices.map((service) => (
                <SelectItem
                  key={service.fullName}
                  value={service.fullName}
                  className="font-mono text-sp-12"
                >
                  {service.fullName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <TextField
            mono
            size="sm"
            value={serviceValue}
            onChange={(e) => onServiceTextChange(e.target.value)}
            placeholder="Service (e.g., greet.v1.GreetService)"
            className={cn('w-full', !serviceValidation.valid && 'border-red-500')}
          />
        )}
        {!serviceValidation.valid && serviceValidation.error && (
          <div
            className="text-sp-11 mt-1 flex items-center gap-1 font-mono"
            style={{ color: '#ef4444' }}
          >
            <AlertCircle className="h-3 w-3" />
            {serviceValidation.error}
          </div>
        )}
      </div>

      <div className="flex-1 relative">
        {hasReflectionMethods ? (
          <Select
            value={selectedMethod?.name || ''}
            onValueChange={(value) => {
              const method = reflectionMethods.find((m) => m.name === value);
              if (method) onSelectMethod(method);
            }}
          >
            <SelectTrigger
              className={cn(
                'h-8 font-mono text-sp-12 bg-sp-surface-lo border-sp-line text-sp-text',
                !methodValidation.valid && 'border-red-500'
              )}
            >
              <SelectValue placeholder="Select method" />
            </SelectTrigger>
            <SelectContent>
              {reflectionMethods.map((method) => {
                const label = streamingLabel(method);
                const desktopOnly = requiresDesktop(method);
                return (
                  <SelectItem
                    key={method.name}
                    value={method.name}
                    className="font-mono text-sp-12"
                  >
                    {method.name}
                    {label && (
                      <span className="ml-2 text-sp-10 text-sp-muted">{label}</span>
                    )}
                    {desktopOnly && (
                      <span
                        className="ml-2 inline-flex items-center gap-1 rounded-sm bg-amber-500/15 px-1 py-0.5 text-[9px] font-medium text-amber-700 dark:text-amber-400"
                        title="Client-streaming and bidirectional methods require the Restura desktop app"
                      >
                        <Laptop className="size-2.5" />
                        Desktop only
                      </span>
                    )}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        ) : (
          <TextField
            mono
            size="sm"
            value={methodValue}
            onChange={(e) => onMethodTextChange(e.target.value)}
            placeholder="Method (e.g., Greet)"
            className={cn('w-full', !methodValidation.valid && 'border-red-500')}
          />
        )}
        {!methodValidation.valid && methodValidation.error && (
          <div
            className="text-sp-11 mt-1 flex items-center gap-1 font-mono"
            style={{ color: '#ef4444' }}
          >
            <AlertCircle className="h-3 w-3" />
            {methodValidation.error}
          </div>
        )}
      </div>
    </>
  );
}

export default GrpcMethodSelector;
