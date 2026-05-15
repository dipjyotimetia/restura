import { AlertCircle } from 'lucide-react';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { ReflectionMethodInfo, ReflectionServiceInfo } from '@/types';

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
 * Service + method dropdowns for the gRPC request builder.
 *
 * When reflection has discovered services, shows two dependent <Select>s
 * (service → method). Otherwise, falls back to free-text <Input>s so the
 * user can type a service/method that isn't reflectable.
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
              className={`font-mono text-xs bg-background border-border ${!serviceValidation.valid ? 'border-destructive' : ''}`}
            >
              <SelectValue placeholder="Select service" />
            </SelectTrigger>
            <SelectContent>
              {reflectionServices.map((service) => (
                <SelectItem
                  key={service.fullName}
                  value={service.fullName}
                  className="font-mono text-xs"
                >
                  {service.fullName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Input
            value={serviceValue}
            onChange={(e) => onServiceTextChange(e.target.value)}
            placeholder="Service (e.g., greet.v1.GreetService)"
            className={`font-mono text-xs bg-background border-border ${!serviceValidation.valid ? 'border-destructive' : ''}`}
          />
        )}
        {!serviceValidation.valid && serviceValidation.error && (
          <div className="text-xs text-destructive mt-1 flex items-center gap-1">
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
              className={`font-mono text-xs bg-background border-border ${!methodValidation.valid ? 'border-destructive' : ''}`}
            >
              <SelectValue placeholder="Select method" />
            </SelectTrigger>
            <SelectContent>
              {reflectionMethods.map((method) => {
                const label = streamingLabel(method);
                return (
                  <SelectItem
                    key={method.name}
                    value={method.name}
                    className="font-mono text-xs"
                  >
                    {method.name}
                    {label && (
                      <span className="ml-2 text-[10px] text-muted-foreground">
                        {label}
                      </span>
                    )}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        ) : (
          <Input
            value={methodValue}
            onChange={(e) => onMethodTextChange(e.target.value)}
            placeholder="Method (e.g., Greet)"
            className={`font-mono text-xs bg-background border-border ${!methodValidation.valid ? 'border-destructive' : ''}`}
          />
        )}
        {!methodValidation.valid && methodValidation.error && (
          <div className="text-xs text-destructive mt-1 flex items-center gap-1">
            <AlertCircle className="h-3 w-3" />
            {methodValidation.error}
          </div>
        )}
      </div>
    </>
  );
}

export default GrpcMethodSelector;
