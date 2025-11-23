'use client';

import { useState, useCallback, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Radio, Loader2, CheckCircle, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import {
  GrpcReflectionClient,
  generateRequestTemplate,
  formatMessageSchemaForDisplay,
} from '@/features/grpc/lib/grpcReflection';
import { validateGrpcUrl } from '@/features/grpc/lib/grpcClient';
import { ReflectionServiceInfo, ReflectionMethodInfo, ReflectionResult, GrpcMethodType } from '@/types';
import { withErrorBoundary } from '@/components/shared/ErrorBoundary';

interface GrpcReflectionPanelProps {
  url: string;
  resolveVariables: (text: string) => string;
  onServiceSelect: (serviceName: string) => void;
  onMethodSelect: (methodName: string, methodType: GrpcMethodType, message?: string) => void;
}

function GrpcReflectionPanel({
  url,
  resolveVariables,
  onServiceSelect,
  onMethodSelect,
}: GrpcReflectionPanelProps) {
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [reflectionResult, setReflectionResult] = useState<ReflectionResult | null>(null);
  const [selectedReflectionService, setSelectedReflectionService] = useState<ReflectionServiceInfo | null>(null);
  const [selectedReflectionMethod, setSelectedReflectionMethod] = useState<ReflectionMethodInfo | null>(null);

  const handleDiscoverServices = useCallback(async (silent = false) => {
    if (!url) {
      if (!silent) {
        toast.error('URL required', {
          description: 'Please enter a gRPC server URL before discovering services',
        });
      }
      return;
    }

    const urlValidation = validateGrpcUrl(url);
    if (!urlValidation.valid) {
      if (!silent) {
        toast.error('Invalid URL', {
          description: urlValidation.error,
        });
      }
      return;
    }

    setIsDiscovering(true);
    if (!silent) {
      setReflectionResult(null);
      setSelectedReflectionService(null);
      setSelectedReflectionMethod(null);
    }

    try {
      const resolvedUrl = resolveVariables(url);
      const client = new GrpcReflectionClient(resolvedUrl);
      const result = await client.discoverServices();

      if (result.success) {
        setReflectionResult(result);
        if (result.services.length === 0) {
          if (!silent) {
            toast.warning('No services found', {
              description: 'The server has reflection enabled but no services were discovered',
            });
          }
        } else {
          if (!silent) {
            toast.success('Services discovered', {
              description: `Found ${result.services.length} service(s) with ${result.services.reduce((sum, s) => sum + s.methods.length, 0)} method(s)`,
            });
          }

          // Auto-select first service and method
          const firstService = result.services[0];
          if (firstService) {
            setSelectedReflectionService(firstService);
            onServiceSelect(firstService.fullName);

            if (firstService.methods.length > 0) {
              const firstMethod = firstService.methods[0];
              if (firstMethod) {
                setSelectedReflectionMethod(firstMethod);
                handleMethodSelection(firstMethod);
              }
            }
          }
        }
      } else {
        if (!silent) {
          toast.error('Discovery failed', {
            description: result.error || 'Failed to discover services via reflection',
          });
          setReflectionResult({
            success: false,
            services: [],
            error: result.error,
            serverUrl: url,
            timestamp: Date.now(),
          });
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      if (!silent) {
        toast.error('Discovery failed', {
          description: errorMessage,
        });
        setReflectionResult({
          success: false,
          services: [],
          error: errorMessage,
          serverUrl: url,
          timestamp: Date.now(),
        });
      }
    } finally {
      setIsDiscovering(false);
    }
  }, [url, resolveVariables, onServiceSelect]);

  // Auto-discover services when URL changes
  useEffect(() => {
    if (!url) return;
    const { valid } = validateGrpcUrl(url);
    if (!valid) return;

    const timer = setTimeout(() => {
      if (reflectionResult?.serverUrl !== url) {
        handleDiscoverServices(true);
      }
    }, 1500);

    return () => clearTimeout(timer);
  }, [url, handleDiscoverServices, reflectionResult?.serverUrl]);

  const handleServiceSelection = (service: ReflectionServiceInfo) => {
    setSelectedReflectionService(service);
    setSelectedReflectionMethod(null);
    onServiceSelect(service.fullName);
  };

  const handleMethodSelection = (method: ReflectionMethodInfo) => {
    setSelectedReflectionMethod(method);

    let methodType: GrpcMethodType = 'unary';
    if (method.clientStreaming && method.serverStreaming) {
      methodType = 'bidirectional-streaming';
    } else if (method.serverStreaming) {
      methodType = 'server-streaming';
    } else if (method.clientStreaming) {
      methodType = 'client-streaming';
    }

    let message: string | undefined;
    if (method.inputMessageSchema && method.inputMessageSchema.fields.length > 0) {
      message = generateRequestTemplate(method.inputMessageSchema);
      toast.info('Request template generated', {
        description: `Generated template for ${method.inputMessageSchema.name}`,
      });
    }

    onMethodSelect(method.name, methodType, message);
  };

  const hasServices = reflectionResult?.success && reflectionResult.services.length > 0;

  return (
    <>
      {/* Service Selector */}
      {hasServices ? (
        <Select
          value={selectedReflectionService?.fullName || ''}
          onValueChange={(value) => {
            const service = reflectionResult!.services.find((s) => s.fullName === value);
            if (service) handleServiceSelection(service);
          }}
        >
          <SelectTrigger className="flex-1 bg-background border-border">
            <SelectValue placeholder="Select service" />
          </SelectTrigger>
          <SelectContent>
            {reflectionResult!.services.filter(s => s.fullName).map((service) => (
              <SelectItem key={service.fullName} value={service.fullName}>
                {service.fullName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}

      {/* Method Selector */}
      {selectedReflectionService && selectedReflectionService.methods.length > 0 ? (
        <Select
          value={selectedReflectionMethod?.name || ''}
          onValueChange={(value) => {
            const method = selectedReflectionService.methods.find((m) => m.name === value);
            if (method) handleMethodSelection(method);
          }}
        >
          <SelectTrigger className="flex-1 bg-background border-border">
            <SelectValue placeholder="Select method" />
          </SelectTrigger>
          <SelectContent>
            {selectedReflectionService.methods.filter(m => m.name).map((method) => (
              <SelectItem key={method.name} value={method.name}>
                {method.name}
                {method.clientStreaming || method.serverStreaming ? (
                  <span className="ml-2 text-xs text-muted-foreground">
                    {method.clientStreaming && method.serverStreaming
                      ? '(bidi)'
                      : method.serverStreaming
                        ? '(server stream)'
                        : '(client stream)'}
                  </span>
                ) : null}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}

      {/* Discover Button */}
      <Button
        variant="outline"
        onClick={() => handleDiscoverServices(false)}
        disabled={isDiscovering || !url}
        title="Discover services via gRPC reflection"
      >
        {isDiscovering ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <Radio className="mr-2 h-4 w-4" />
        )}
        {isDiscovering ? 'Discovering...' : 'Discover'}
      </Button>
    </>
  );
}

// Separate component for reflection result info display
export function GrpcReflectionInfo({
  reflectionResult,
  selectedMethod,
  showSchemaInfo,
  onToggleSchema,
}: {
  reflectionResult: ReflectionResult | null;
  selectedMethod: ReflectionMethodInfo | null;
  showSchemaInfo: boolean;
  onToggleSchema: () => void;
}) {
  if (!reflectionResult) return null;

  return (
    <div
      className={`p-2 rounded text-xs space-y-1 ${reflectionResult.success ? 'bg-green-500/10 dark:bg-green-500/10' : 'bg-red-500/10 dark:bg-red-500/10'}`}
    >
      <div className="flex items-center gap-1 font-medium">
        <Radio className="h-3 w-3" />
        gRPC Reflection
        {reflectionResult.success ? (
          <CheckCircle className="h-3 w-3 text-green-500" />
        ) : (
          <AlertCircle className="h-3 w-3 text-red-500" />
        )}
      </div>
      {reflectionResult.success ? (
        <>
          <div>
            Services: {reflectionResult.services.length} | Methods:{' '}
            {reflectionResult.services.reduce((sum, s) => sum + s.methods.length, 0)}
          </div>
          {selectedMethod && (
            <div className="mt-2">
              <div className="font-medium">Selected Method:</div>
              <div>
                Input: {selectedMethod.inputType.split('.').pop()} | Output:{' '}
                {selectedMethod.outputType.split('.').pop()}
              </div>
              <Button
                variant="link"
                size="sm"
                className="p-0 h-auto text-xs"
                onClick={onToggleSchema}
              >
                {showSchemaInfo ? 'Hide Schema' : 'Show Schema'}
              </Button>
              {showSchemaInfo && selectedMethod.inputMessageSchema && (
                <pre className="mt-1 p-2 bg-muted rounded text-xs overflow-x-auto">
                  {formatMessageSchemaForDisplay(selectedMethod.inputMessageSchema)}
                </pre>
              )}
            </div>
          )}
        </>
      ) : (
        <div className="text-red-600 dark:text-red-400">{reflectionResult.error}</div>
      )}
    </div>
  );
}

export default withErrorBoundary(GrpcReflectionPanel);
