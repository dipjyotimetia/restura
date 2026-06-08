import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import type { ReflectionMethodInfo, ReflectionResult, ReflectionServiceInfo } from '@/types';
import { GrpcReflectionClient } from '@/features/grpc/lib/grpcReflection';
import { validateGrpcUrl } from '@/features/grpc/lib/grpcValidation';

const AUTO_DISCOVER_DEBOUNCE_MS = 1500;

export interface UseGrpcReflectionOptions {
  /** The gRPC server URL (raw, before env-var resolution). */
  url: string | undefined;
  /** Resolve {{var}} references in the URL before contacting the server. */
  resolveVariables: (text: string) => string;
  /**
   * Whether to auto-discover when the URL changes. Defaults to true. Disable
   * for tests or when the parent isn't ready (e.g. no active request).
   */
  autoDiscover?: boolean;
  /**
   * Apply parent-side effects when a service is selected (e.g. update the
   * request store and run field validators). The hook also tracks the
   * selection internally for its own UI.
   */
  onServiceSelected?: (service: ReflectionServiceInfo) => void;
  /**
   * Apply parent-side effects when a method is selected (e.g. update the
   * request store with method/methodType/template and validate). The parent
   * owns template generation because it also has to push the result into
   * the request store and call the message validator.
   */
  onMethodSelected?: (method: ReflectionMethodInfo) => void;
}

export interface UseGrpcReflectionResult {
  /** Most recent discovery result (success or error), or null before any attempt. */
  result: ReflectionResult | null;
  /** Currently selected service from the discovery result. */
  selectedService: ReflectionServiceInfo | null;
  /** Currently selected method from the selected service. */
  selectedMethod: ReflectionMethodInfo | null;
  /** True while a discovery request is in flight. */
  loading: boolean;
  /** Whether the schema details panel is expanded. */
  showSchema: boolean;
  setShowSchema: (next: boolean) => void;
  /** Programmatically select a service (also clears the method selection). */
  selectService: (service: ReflectionServiceInfo) => void;
  /** Programmatically select a method on the current service. */
  selectMethod: (method: ReflectionMethodInfo) => void;
  /**
   * Trigger discovery against the current URL. `silent` suppresses toasts and
   * skips clearing existing selections — used for the auto-discover path.
   */
  discover: (silent?: boolean) => Promise<void>;
}

/**
 * Encapsulates gRPC server reflection state: discovery, selection, schema
 * panel toggle, and the debounced auto-discovery effect that fires when the
 * URL changes. Parents pass `onServiceSelected` / `onMethodSelected` to apply
 * any external side effects (request-store updates, field validation,
 * template generation) when the user picks something from a discovered list.
 *
 * Behaviour preserved from the original GrpcRequestBuilder inline implementation:
 *  - When discovery succeeds and finds at least one service, the first
 *    service (and its first method) auto-selects to populate the form.
 *  - When discovery fails, a toast surfaces the error unless `silent`.
 *  - When the URL is invalid or empty, auto-discovery is a no-op.
 *  - Auto-discovery is skipped if the most recent result already targeted
 *    the same URL — prevents thrashing when the parent re-renders.
 */
export function useGrpcReflection(options: UseGrpcReflectionOptions): UseGrpcReflectionResult {
  const {
    url,
    resolveVariables,
    autoDiscover = true,
    onServiceSelected,
    onMethodSelected,
  } = options;

  const [result, setResult] = useState<ReflectionResult | null>(null);
  const [selectedService, setSelectedService] = useState<ReflectionServiceInfo | null>(null);
  const [selectedMethod, setSelectedMethod] = useState<ReflectionMethodInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [showSchema, setShowSchema] = useState(false);

  const selectService = useCallback(
    (service: ReflectionServiceInfo) => {
      setSelectedService(service);
      setSelectedMethod(null);
      onServiceSelected?.(service);
    },
    [onServiceSelected]
  );

  const selectMethod = useCallback(
    (method: ReflectionMethodInfo) => {
      setSelectedMethod(method);
      onMethodSelected?.(method);
    },
    [onMethodSelected]
  );

  const discover = useCallback(
    async (silent = false) => {
      const rawUrl = url ?? '';
      if (!rawUrl) {
        if (!silent) {
          toast.error('URL required', {
            description: 'Please enter a gRPC server URL before discovering services',
          });
        }
        return;
      }

      const urlValidation = validateGrpcUrl(rawUrl);
      if (!urlValidation.valid) {
        if (!silent) {
          toast.error('Invalid URL', { description: urlValidation.error });
        }
        return;
      }

      setLoading(true);
      if (!silent) {
        setResult(null);
        setSelectedService(null);
        setSelectedMethod(null);
      }

      try {
        const resolvedUrl = resolveVariables(rawUrl);
        const client = new GrpcReflectionClient(resolvedUrl);
        const discoveryResult = await client.discoverServices();

        if (discoveryResult.success) {
          setResult(discoveryResult);
          if (discoveryResult.services.length === 0) {
            if (!silent) {
              toast.warning('No services found', {
                description: 'The server has reflection enabled but no services were discovered',
              });
            }
          } else {
            if (!silent) {
              toast.success('Services discovered', {
                description: `Found ${discoveryResult.services.length} service(s) with ${discoveryResult.services.reduce(
                  (sum, s) => sum + s.methods.length,
                  0
                )} method(s)`,
              });
            }
            const firstService = discoveryResult.services[0];
            if (firstService) {
              selectService(firstService);
              const firstMethod = firstService.methods[0];
              if (firstMethod) {
                selectMethod(firstMethod);
              }
            }
          }
        } else {
          // Record the failure even on the silent auto-discover path so the
          // persistent reflection banner shows *why* (e.g. a TLS / certificate
          // error) instead of nothing. Recording the URL also stops the
          // auto-discover effect from re-firing against the same failing URL.
          // The toast stays manual-only to avoid spam while the user types.
          setResult({
            success: false,
            services: [],
            error: discoveryResult.error,
            serverUrl: rawUrl,
            timestamp: Date.now(),
          });
          if (!silent) {
            toast.error('Discovery failed', {
              description: discoveryResult.error || 'Failed to discover services via reflection',
            });
          }
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
        setResult({
          success: false,
          services: [],
          error: errorMessage,
          serverUrl: rawUrl,
          timestamp: Date.now(),
        });
        if (!silent) {
          toast.error('Discovery failed', { description: errorMessage });
        }
      } finally {
        setLoading(false);
      }
    },
    [url, resolveVariables, selectService, selectMethod]
  );

  // Debounced auto-discovery on URL change. We compare against the previous
  // result's serverUrl to skip re-running for the same URL when other deps
  // change (e.g. the parent re-renders).
  useEffect(() => {
    if (!autoDiscover) return;
    const rawUrl = url ?? '';
    if (!rawUrl) return;
    const { valid } = validateGrpcUrl(rawUrl);
    if (!valid) return;

    const timer = setTimeout(() => {
      if (result?.serverUrl !== rawUrl) {
        void discover(true);
      }
    }, AUTO_DISCOVER_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [url, autoDiscover, discover, result?.serverUrl]);

  return {
    result,
    selectedService,
    selectedMethod,
    loading,
    showSchema,
    setShowSchema,
    selectService,
    selectMethod,
    discover,
  };
}
