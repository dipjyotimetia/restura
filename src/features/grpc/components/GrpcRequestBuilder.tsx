import { useState, useCallback, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useRequestStore } from '@/store/useRequestStore';
import { useHistoryStore } from '@/store/useHistoryStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useShallow } from 'zustand/react/shallow';
import type {
  AuthConfig as AuthConfigType,
  GrpcMethodType,
  GrpcRequest,
  ProtoFileInfo,
} from '@/types';
import { Send, AlertCircle, CheckCircle, Loader2, Radio } from 'lucide-react';
import AuthConfiguration from '@/features/auth/components/AuthConfig';
import { lazyComponent } from '@/lib/shared/lazyComponent';
import {
  validateMethodName,
  getMethodTypeDescription,
  GrpcClientError,
  buildAuthMetadata,
  makeElectronGrpcRequest,
  makeProxyGrpcRequest,
  startElectronGrpcStream,
  validateGrpcUrl,
  validateServiceName,
  createErrorResponse,
} from '@/features/grpc/lib/grpcClient';
import ScriptExecutor from '@/features/scripts/lib/scriptExecutor';
import { isElectron } from '@/lib/shared/platform';
import {
  GrpcReflectionClient,
  generateRequestTemplate,
  formatMessageSchemaForDisplay,
  generateProtoFromReflection,
  validateRequestAgainstSchema,
} from '@/features/grpc/lib/grpcReflection';
import { toast } from 'sonner';
import type { ReflectionServiceInfo, ReflectionMethodInfo, ReflectionResult } from '@/types';
import { useKeyValueCollection } from '@/hooks/useKeyValueCollection';
import { withErrorBoundary } from '@/components/shared/ErrorBoundary';
import KeyValueEditor from '@/components/shared/KeyValueEditor';
import GrpcProtoUploader, { GrpcProtoInfo } from './GrpcProtoUploader';
import GrpcStreamingControls, { GrpcStreamingMessages } from './GrpcStreamingControls';
import ScriptsEditor from '@/features/scripts/components/ScriptsEditor';

const CodeEditor = lazyComponent(() => import('@/components/shared/CodeEditor'));

// Pure utility — defined outside component so validateMessage useCallback captures a stable reference
function calculateJsonDepth(obj: unknown, currentDepth = 0): number {
  if (obj === null || typeof obj !== 'object') return currentDepth;
  const values = Array.isArray(obj) ? obj : Object.values(obj as Record<string, unknown>);
  if (values.length === 0) return currentDepth + 1;
  return Math.max(...values.map((value) => calculateJsonDepth(value, currentDepth + 1)));
}

interface ValidationState {
  url: { valid: boolean; error?: string };
  service: { valid: boolean; error?: string };
  method: { valid: boolean; error?: string };
  message: { valid: boolean; error?: string };
}

function GrpcRequestBuilder() {
  const { currentRequest, updateRequest, setLoading, setCurrentResponse, setScriptResult, isLoading } = useRequestStore(
    useShallow((s) => ({ currentRequest: s.currentRequest, updateRequest: s.updateRequest, setLoading: s.setLoading, setCurrentResponse: s.setCurrentResponse, setScriptResult: s.setScriptResult, isLoading: s.isLoading }))
  );
  const { addHistoryItem } = useHistoryStore();
  const { resolveVariables, getActiveEnvironment, updateVariable } = useEnvironmentStore();
  const [activeTab, setActiveTab] = useState('message');
  const [protoFile, setProtoFile] = useState<File | null>(null);
  const [protoInfo, setProtoInfo] = useState<ProtoFileInfo | null>(null);
  const [validation, setValidation] = useState<ValidationState>({
    url: { valid: true },
    service: { valid: true },
    method: { valid: true },
    message: { valid: true },
  });
  const [streamingMessages, setStreamingMessages] = useState<string[]>([]);
  const [streamControl, setStreamControl] = useState<{
    sendMessage: (msg: unknown) => void;
    endStream: () => void;
    cancelStream: () => void;
  } | null>(null);
  const [timeoutMs, setTimeoutMs] = useState(30000);
  const [retryMaxAttempts, setRetryMaxAttempts] = useState(1);
  const [retryDelayMs, setRetryDelayMs] = useState(0);
  const [useCompression, setUseCompression] = useState(false);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [reflectionResult, setReflectionResult] = useState<ReflectionResult | null>(null);
  const [selectedReflectionService, setSelectedReflectionService] = useState<ReflectionServiceInfo | null>(null);
  const [selectedReflectionMethod, setSelectedReflectionMethod] = useState<ReflectionMethodInfo | null>(null);
  const [showSchemaInfo, setShowSchemaInfo] = useState(false);

  // Stable URL reference for use in callbacks and effects — must compute before early return
  const grpcUrl = (currentRequest as GrpcRequest | null)?.url;

  // All hooks must be called before any early return — Rules of Hooks
  const {
    handleAdd: handleAddMetadata,
    handleUpdate: handleUpdateMetadata,
    handleDelete: handleDeleteMetadata,
  } = useKeyValueCollection(
    (currentRequest as GrpcRequest | null)?.metadata ?? [],
    (metadata) => updateRequest({ metadata })
  );

  const validateUrl = useCallback((url: string) => {
    const result = validateGrpcUrl(url);
    setValidation((prev) => ({ ...prev, url: result }));
    return result.valid;
  }, []);

  const validateService = useCallback((service: string) => {
    if (!service) {
      setValidation((prev) => ({ ...prev, service: { valid: true } }));
      return true;
    }
    const result = validateServiceName(service);
    setValidation((prev) => ({ ...prev, service: result }));
    return result.valid;
  }, []);

  const validateMethod = useCallback((method: string) => {
    if (!method) {
      setValidation((prev) => ({ ...prev, method: { valid: true } }));
      return true;
    }
    const result = validateMethodName(method);
    setValidation((prev) => ({ ...prev, method: result }));
    return result.valid;
  }, []);

  const validateMessage = useCallback((message: string) => {
    if (!message || message.trim() === '') {
      setValidation((prev) => ({ ...prev, message: { valid: true } }));
      return true;
    }
    const MAX_SIZE_BYTES = 10 * 1024 * 1024;
    const sizeBytes = new Blob([message]).size;
    if (sizeBytes > MAX_SIZE_BYTES) {
      setValidation((prev) => ({
        ...prev,
        message: {
          valid: false,
          error: `Message size (${(sizeBytes / 1024 / 1024).toFixed(2)}MB) exceeds maximum allowed size of 10MB`,
        },
      }));
      return false;
    }
    try {
      const parsed = JSON.parse(message);
      const MAX_DEPTH = 20;
      const depth = calculateJsonDepth(parsed);
      if (depth > MAX_DEPTH) {
        setValidation((prev) => ({
          ...prev,
          message: {
            valid: false,
            error: `JSON depth (${depth}) exceeds maximum allowed depth of ${MAX_DEPTH} levels`,
          },
        }));
        return false;
      }
      setValidation((prev) => ({ ...prev, message: { valid: true } }));
      return true;
    } catch {
      setValidation((prev) => ({
        ...prev,
        message: { valid: false, error: 'Invalid JSON format' },
      }));
      return false;
    }
  }, []);

  const handleSelectReflectionService = (service: ReflectionServiceInfo) => {
    setSelectedReflectionService(service);
    updateRequest({ service: service.fullName });
    validateService(service.fullName);
    setSelectedReflectionMethod(null);
  };

  const handleSelectReflectionMethod = (method: ReflectionMethodInfo) => {
    setSelectedReflectionMethod(method);
    updateRequest({ method: method.name });
    validateMethod(method.name);
    let methodType: GrpcMethodType = 'unary';
    if (method.clientStreaming && method.serverStreaming) {
      methodType = 'bidirectional-streaming';
    } else if (method.serverStreaming) {
      methodType = 'server-streaming';
    } else if (method.clientStreaming) {
      methodType = 'client-streaming';
    }
    updateRequest({ methodType });
    if (method.inputMessageSchema && method.inputMessageSchema.fields.length > 0) {
      const template = generateRequestTemplate(method.inputMessageSchema);
      updateRequest({ message: template });
      validateMessage(template);
      toast.info('Request template generated', {
        description: `Generated template for ${method.inputMessageSchema.name}`,
      });
    }
  };

  const handleDiscoverServices = useCallback(async (silent = false) => {
    const url = grpcUrl ?? '';
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
        toast.error('Invalid URL', { description: urlValidation.error });
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
          const firstService = result.services[0];
          if (firstService) {
            setSelectedReflectionService(firstService);
            handleSelectReflectionService(firstService);
            if (firstService.methods.length > 0) {
              const firstMethod = firstService.methods[0];
              if (firstMethod) {
                setSelectedReflectionMethod(firstMethod);
                handleSelectReflectionMethod(firstMethod);
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
        toast.error('Discovery failed', { description: errorMessage });
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
  }, [grpcUrl, resolveVariables]);

  // Auto-discover services when URL changes
  useEffect(() => {
    if (!currentRequest || currentRequest.type !== 'grpc') return;
    const url = grpcUrl ?? '';
    if (!url) return;
    const { valid } = validateGrpcUrl(url);
    if (!valid) return;

    const timer = setTimeout(() => {
      if (reflectionResult?.serverUrl !== url) {
        handleDiscoverServices(true);
      }
    }, 1500);

    return () => clearTimeout(timer);
  }, [grpcUrl, handleDiscoverServices, reflectionResult?.serverUrl]);

  // Keep a ref so unmount cleanup always sees the current stream without re-running the effect
  const streamControlRef = useRef(streamControl);
  useEffect(() => { streamControlRef.current = streamControl; }, [streamControl]);

  useEffect(() => {
    return () => {
      try { streamControlRef.current?.cancelStream(); } catch { /* ignore cleanup errors */ }
    };
  }, []);

  if (!currentRequest || currentRequest.type !== 'grpc') {
    return null;
  }

  const grpcRequest = currentRequest as GrpcRequest;

  const handleMethodTypeChange = (methodType: GrpcMethodType) => {
    updateRequest({ methodType });
    setStreamingMessages([]);
  };

  const handleUrlChange = (url: string) => {
    updateRequest({ url });
    validateUrl(url);
  };

  const handleServiceChange = (service: string) => {
    updateRequest({ service });
    validateService(service);
  };

  const handleMethodChange = (method: string) => {
    updateRequest({ method });
    validateMethod(method);
  };

  const handleMessageChange = (message: string) => {
    updateRequest({ message });
    validateMessage(message);
  };

  const handleAuthChange = (auth: AuthConfigType) => {
    updateRequest({ auth });
  };

  const handleSendRequest = async () => {
    const urlValid = validateUrl(grpcRequest.url);
    const serviceValid = validateService(grpcRequest.service);
    const methodValid = validateMethod(grpcRequest.method);
    const messageValid = validateMessage(grpcRequest.message);

    if (!urlValid || !serviceValid || !methodValid || !messageValid) {
      toast.error('Validation failed', {
        description: 'Please fix the validation errors before sending the request',
      });
      return;
    }

    // Schema validation against reflection schema (if available)
    if (selectedReflectionMethod?.inputMessageSchema && grpcRequest.message) {
      try {
        const parsed = JSON.parse(grpcRequest.message);
        const schemaValidation = validateRequestAgainstSchema(parsed, selectedReflectionMethod.inputMessageSchema);
        if (!schemaValidation.valid) {
          toast.warning('Schema validation warnings', {
            description: schemaValidation.errors.slice(0, 3).join('; '),
          });
        }
      } catch {
        // JSON parse already handled above by validateMessage
      }
    }

    setLoading(true);
    setStreamingMessages([]);
    setScriptResult(null);
    const startTime = Date.now();

    // Build env vars snapshot for script execution
    const activeEnv = getActiveEnvironment();
    const envVars: Record<string, string> = {};
    if (activeEnv) {
      activeEnv.variables.filter((v) => v.enabled).forEach((v) => { envVars[v.key] = v.value; });
    }

    // Pre-request script
    let preRequestResult;
    if (grpcRequest.preRequestScript?.trim()) {
      const executor = new ScriptExecutor(envVars, {});
      preRequestResult = await executor.executeScript(grpcRequest.preRequestScript, {
        request: { url: grpcRequest.url, method: grpcRequest.methodType, headers: {}, body: grpcRequest.message },
      });
      if (preRequestResult.variables) {
        Object.assign(envVars, preRequestResult.variables);
        if (activeEnv) {
          Object.entries(preRequestResult.variables).forEach(([key, value]) => {
            const variable = activeEnv.variables.find((v) => v.key === key);
            if (variable) updateVariable(activeEnv.id, variable.id, { value });
          });
        }
      }
    }

    try {
      let protoContent: string;
      let protoFileName: string;

      if (protoFile) {
        protoContent = await protoFile.text();
        protoFileName = protoFile.name;
      } else if (reflectionResult?.success && selectedReflectionService) {
        protoContent = generateProtoFromReflection(grpcRequest.service, selectedReflectionService);
        protoFileName = 'generated.proto';
      } else {
        toast.error('Proto file or reflection required', {
          description: 'Please upload a .proto file or use a server with gRPC reflection enabled.',
        });
        setLoading(false);
        return;
      }

      if (grpcRequest.methodType !== 'unary') {
        if (!isElectron()) {
          toast.error('Streaming gRPC requires the desktop app', {
            description: 'Unary requests are supported in the browser via the proxy.',
          });
          setLoading(false);
          return;
        }
        const control = startElectronGrpcStream(
          grpcRequest,
          protoContent,
          protoFileName,
          resolveVariables,
          {
            onData: (data: unknown) => {
              setStreamingMessages((prev) => [...prev, JSON.stringify(data, null, 2)]);
            },
            onError: (error: unknown) => {
              const err = error as { status: number; details: string };
              toast.error(`gRPC Error: ${err.status}`, {
                description: err.details || 'Unknown error',
              });
              setLoading(false);
              setStreamControl(null);
            },
            onStatus: (status: unknown) => {
              const s = status as { status: number; details: string };
              if (s.status === 0) toast.success('Stream completed');
              setLoading(false);
              setStreamControl(null);
            },
          },
          timeoutMs,
          useCompression
        );
        setStreamControl(control);
        return;
      }

      let response = isElectron()
        ? await makeElectronGrpcRequest(grpcRequest, protoContent, protoFileName, resolveVariables, timeoutMs, useCompression)
        : await makeProxyGrpcRequest(grpcRequest, resolveVariables, timeoutMs);

      // Retry on non-OK status (status !== 0) if retry policy configured
      for (let attempt = 2; attempt <= retryMaxAttempts && response.grpcStatus !== 0; attempt++) {
        if (retryDelayMs > 0) {
          await new Promise((r) => setTimeout(r, retryDelayMs));
        }
        toast.info(`Retrying... (attempt ${attempt}/${retryMaxAttempts})`);
        response = isElectron()
          ? await makeElectronGrpcRequest(grpcRequest, protoContent, protoFileName, resolveVariables, timeoutMs, useCompression)
          : await makeProxyGrpcRequest(grpcRequest, resolveVariables, timeoutMs);
      }

      setCurrentResponse(response);
      addHistoryItem(grpcRequest, response);

      // Test script
      let testResult;
      if (grpcRequest.testScript?.trim()) {
        const executor = new ScriptExecutor(envVars, {});
        testResult = await executor.executeScript(grpcRequest.testScript, {
          request: { url: grpcRequest.url, method: grpcRequest.methodType, headers: {}, body: grpcRequest.message },
          response: {
            status: response.grpcStatus ?? 0,
            statusText: response.grpcStatusText ?? '',
            headers: {},
            body: response.body,
            time: response.time,
            size: response.size,
          },
        });
      }

      setScriptResult({ preRequest: preRequestResult, test: testResult });

      if (response.grpcStatus === 0) {
        toast.success('Request completed', {
          description: `${grpcRequest.methodType} call to ${grpcRequest.service}/${grpcRequest.method}`,
        });
        if (response.messages) {
          setStreamingMessages(response.messages);
        }
      } else {
        toast.error(`gRPC Error: ${response.grpcStatus}`, {
          description: response.grpcStatusText || 'Unknown error',
        });
      }
    } catch (error: unknown) {
      console.error('gRPC request error:', error);
      // Always clear loading on error — stream never started if we're in catch
      setLoading(false);
      setStreamControl(null);
      const errorResponse = createErrorResponse(grpcRequest.id, error, startTime);
      setCurrentResponse(errorResponse);
      addHistoryItem(grpcRequest, errorResponse);

      if (error instanceof GrpcClientError) {
        toast.error(`gRPC Error: ${error.statusCode}`, { description: error.message });
      } else {
        const errorMessage = error instanceof Error ? error.message : 'gRPC request failed';
        toast.error('Request failed', { description: errorMessage });
      }
    } finally {
      if (grpcRequest.methodType === 'unary') {
        setLoading(false);
      }
    }
  };

  const isFormValid = () => {
    return (
      grpcRequest.url &&
      grpcRequest.service &&
      grpcRequest.method &&
      validation.url.valid &&
      validation.service.valid &&
      validation.method.valid &&
      validation.message.valid
    );
  };

  const getAuthPreview = () => {
    const authMetadata = buildAuthMetadata(grpcRequest.auth);
    if (Object.keys(authMetadata).length === 0) return 'No authentication configured';
    return Object.entries(authMetadata)
      .map(([key, value]) => {
        const maskedValue =
          key.includes('authorization') || key.includes('password')
            ? value.substring(0, 10) + '...'
            : value;
        return `${key}: ${maskedValue}`;
      })
      .join('\n');
  };

  const activeMetadataCount = grpcRequest.metadata.filter((m) => m.enabled).length;

  return (
    <div className="flex-1 flex flex-col border-b border-border">
      {/* Request Zone */}
      <div className="border-b border-border">
        {/* URL Zone */}
        <div className="flex items-center gap-1 px-3 h-12 border-b border-border bg-surface-2">
          <Select
            value={grpcRequest.methodType}
            onValueChange={(value) => handleMethodTypeChange(value as GrpcMethodType)}
          >
            <SelectTrigger className="w-44 h-7 font-mono text-[11px] font-bold bg-surface-3 border-border shrink-0">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="unary" className="font-mono text-xs">Unary</SelectItem>
              <SelectItem value="server-streaming" className="font-mono text-xs">Server Streaming</SelectItem>
              <SelectItem value="client-streaming" className="font-mono text-xs">Client Streaming</SelectItem>
              <SelectItem value="bidirectional-streaming" className="font-mono text-xs">Bidirectional</SelectItem>
            </SelectContent>
          </Select>
          <span className="text-muted-foreground/40 font-mono text-sm select-none shrink-0">›</span>
          <Input
            value={grpcRequest.url}
            onChange={(e) => handleUrlChange(e.target.value)}
            placeholder="https://api.example.com"
            className="flex-1 h-7 bg-transparent border-0 font-mono text-sm px-2 focus-visible:ring-0 focus-visible:ring-offset-0"
            aria-label="gRPC server URL"
          />
          <Button
            variant="glow"
            size="sm"
            onClick={handleSendRequest}
            disabled={(isLoading && !streamControl) || !isFormValid()}
            aria-label={isLoading ? 'Invoking gRPC method' : 'Invoke gRPC method'}
            className="h-7 min-w-[72px] shrink-0"
          >
            <Send className="mr-1.5 h-3.5 w-3.5" />
            {isLoading ? 'Invoking...' : 'Invoke'}
          </Button>
        </div>

        {/* Streaming controls row */}
        {streamControl && (
          <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-surface-2">
            <span className="text-[10px] font-mono text-muted-foreground uppercase tracking-widest shrink-0">Stream</span>
            <GrpcStreamingControls
              streamControl={streamControl}
              methodType={grpcRequest.methodType}
              onCancel={() => {
                streamControl?.cancelStream();
                setStreamControl(null);
                setLoading(false);
              }}
            />
          </div>
        )}

        {!validation.url.valid && validation.url.error && (
          <div className="text-xs text-destructive mx-3 mt-1 flex items-center gap-1">
            <AlertCircle className="h-3 w-3" />
            {validation.url.error}
          </div>
        )}

        {/* Service / Method row */}
        <div className="flex gap-2 px-3 py-2">
          <div className="flex-1 relative">
            {reflectionResult?.success && reflectionResult.services.length > 0 ? (
              <Select
                value={selectedReflectionService?.fullName || ''}
                onValueChange={(value) => {
                  const service = reflectionResult.services.find((s) => s.fullName === value);
                  if (service) handleSelectReflectionService(service);
                }}
              >
                <SelectTrigger className={`font-mono text-xs bg-background border-border ${!validation.service.valid ? 'border-destructive' : ''}`}>
                  <SelectValue placeholder="Select service" />
                </SelectTrigger>
                <SelectContent>
                  {reflectionResult.services.filter((s) => s.fullName).map((service) => (
                    <SelectItem key={service.fullName} value={service.fullName} className="font-mono text-xs">
                      {service.fullName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                value={grpcRequest.service}
                onChange={(e) => handleServiceChange(e.target.value)}
                placeholder="Service (e.g., greet.v1.GreetService)"
                className={`font-mono text-xs bg-background border-border ${!validation.service.valid ? 'border-destructive' : ''}`}
              />
            )}
            {!validation.service.valid && validation.service.error && (
              <div className="text-xs text-destructive mt-1 flex items-center gap-1">
                <AlertCircle className="h-3 w-3" />
                {validation.service.error}
              </div>
            )}
          </div>

          <div className="flex-1 relative">
            {selectedReflectionService && selectedReflectionService.methods.length > 0 ? (
              <Select
                value={selectedReflectionMethod?.name || ''}
                onValueChange={(value) => {
                  const method = selectedReflectionService.methods.find((m) => m.name === value);
                  if (method) handleSelectReflectionMethod(method);
                }}
              >
                <SelectTrigger className={`font-mono text-xs bg-background border-border ${!validation.method.valid ? 'border-destructive' : ''}`}>
                  <SelectValue placeholder="Select method" />
                </SelectTrigger>
                <SelectContent>
                  {selectedReflectionService.methods.filter((m) => m.name).map((method) => (
                    <SelectItem key={method.name} value={method.name} className="font-mono text-xs">
                      {method.name}
                      {(method.clientStreaming || method.serverStreaming) && (
                        <span className="ml-2 text-[10px] text-muted-foreground">
                          {method.clientStreaming && method.serverStreaming
                            ? '(bidi)'
                            : method.serverStreaming
                              ? '(server stream)'
                              : '(client stream)'}
                        </span>
                      )}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                value={grpcRequest.method}
                onChange={(e) => handleMethodChange(e.target.value)}
                placeholder="Method (e.g., Greet)"
                className={`font-mono text-xs bg-background border-border ${!validation.method.valid ? 'border-destructive' : ''}`}
              />
            )}
            {!validation.method.valid && validation.method.error && (
              <div className="text-xs text-destructive mt-1 flex items-center gap-1">
                <AlertCircle className="h-3 w-3" />
                {validation.method.error}
              </div>
            )}
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={() => handleDiscoverServices(false)}
            disabled={isDiscovering || !grpcRequest.url}
            title="Discover services via gRPC reflection"
            className="shrink-0"
          >
            {isDiscovering ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Radio className="mr-2 h-4 w-4" />
            )}
            {isDiscovering ? 'Discovering...' : 'Discover'}
          </Button>

          <GrpcProtoUploader
            protoFile={protoFile}
            onProtoFileChange={setProtoFile}
            onProtoInfoChange={setProtoInfo}
            onServiceChange={(service) => {
              updateRequest({ service });
              validateService(service);
            }}
            onMethodChange={(method) => {
              updateRequest({ method });
              validateMethod(method);
            }}
            onMethodTypeChange={(methodType) => updateRequest({ methodType })}
          />
        </div>

        <div className="flex items-center gap-4 px-3 pb-2">
          <span className="text-xs text-muted-foreground font-mono">
            {getMethodTypeDescription(grpcRequest.methodType)}
          </span>
          <div className="flex items-center gap-1.5 ml-auto">
            <span className="text-[10px] font-mono text-muted-foreground shrink-0">Timeout (ms)</span>
            <Input
              type="number"
              value={timeoutMs}
              onChange={(e) => setTimeoutMs(Math.max(1000, parseInt(e.target.value, 10) || 30000))}
              className="h-6 w-24 font-mono text-xs bg-background border-border"
              min={1000}
              step={1000}
              aria-label="gRPC request timeout in milliseconds"
            />
          </div>
        </div>

        {/* Web streaming limitation warning */}
        {!isElectron() && grpcRequest.methodType !== 'unary' && (
          <div className="flex items-center gap-2 mx-3 mb-2 p-2 rounded bg-amber-500/10 text-amber-400 text-xs font-mono">
            <AlertCircle className="h-3 w-3 shrink-0" />
            <span>
              Streaming requires the desktop app. In web mode only unary calls are supported.
            </span>
          </div>
        )}

        {/* Reflection result info */}
        {reflectionResult && (
          <div className={`mx-3 mb-2 p-2 rounded text-xs space-y-1 ${reflectionResult.success ? 'bg-emerald-500/10' : 'bg-red-500/10'}`}>
            <div className="flex items-center gap-1 font-mono font-medium">
              <Radio className="h-3 w-3" />
              gRPC Reflection
              {reflectionResult.success ? (
                <CheckCircle className="h-3 w-3 text-emerald-400" />
              ) : (
                <AlertCircle className="h-3 w-3 text-destructive" />
              )}
            </div>
            {reflectionResult.success ? (
              <>
                <div className="font-mono text-muted-foreground">
                  Services: {reflectionResult.services.length} · Methods:{' '}
                  {reflectionResult.services.reduce((sum, s) => sum + s.methods.length, 0)}
                </div>
                {selectedReflectionMethod && (
                  <div className="mt-1">
                    <div className="font-mono text-[10px] text-muted-foreground uppercase tracking-widest">Selected Method</div>
                    <div className="font-mono text-xs">
                      In: {selectedReflectionMethod.inputType.split('.').pop()} · Out:{' '}
                      {selectedReflectionMethod.outputType.split('.').pop()}
                    </div>
                    <Button
                      variant="link"
                      size="sm"
                      className="p-0 h-auto text-xs font-mono"
                      onClick={() => setShowSchemaInfo(!showSchemaInfo)}
                    >
                      {showSchemaInfo ? 'Hide Schema' : 'Show Schema'}
                    </Button>
                    {showSchemaInfo && selectedReflectionMethod.inputMessageSchema && (
                      <pre className="mt-1 p-2 bg-surface-3 rounded text-xs overflow-x-auto font-mono">
                        {formatMessageSchemaForDisplay(selectedReflectionMethod.inputMessageSchema)}
                      </pre>
                    )}
                  </div>
                )}
              </>
            ) : (
              <div className="font-mono text-destructive">{reflectionResult.error}</div>
            )}
          </div>
        )}

        <GrpcProtoInfo protoInfo={protoInfo} />
      </div>

      {/* Request Detail Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col overflow-hidden">
        <TabsList className="w-full justify-start border-b border-border rounded-none h-9 bg-transparent p-0 shrink-0">
          <TabsTrigger
            value="message"
            className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none h-9 px-4 font-mono text-xs"
          >
            Message
            {!validation.message.valid && (
              <AlertCircle className="ml-1 h-3 w-3 text-destructive" />
            )}
          </TabsTrigger>
          <TabsTrigger
            value="metadata"
            className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none h-9 px-4 font-mono text-xs"
          >
            Metadata
            {activeMetadataCount > 0 && (
              <span className="ml-1 text-[10px] text-muted-foreground">({activeMetadataCount})</span>
            )}
          </TabsTrigger>
          <TabsTrigger
            value="auth"
            className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none h-9 px-4 font-mono text-xs"
          >
            Auth
            {grpcRequest.auth.type !== 'none' && (
              <CheckCircle className="ml-1 h-3 w-3 text-emerald-400" />
            )}
          </TabsTrigger>
          <TabsTrigger
            value="settings"
            className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none h-9 px-4 font-mono text-xs"
          >
            Settings
          </TabsTrigger>
          <TabsTrigger
            value="scripts"
            className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none h-9 px-4 font-mono text-xs"
          >
            Scripts
            {(grpcRequest.preRequestScript?.trim() || grpcRequest.testScript?.trim()) && (
              <CheckCircle className="ml-1 h-3 w-3 text-emerald-400" />
            )}
          </TabsTrigger>
          {streamingMessages.length > 0 && (
            <TabsTrigger
              value="streaming"
              className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none h-9 px-4 font-mono text-xs"
            >
              Stream
              <span className="ml-1 text-[10px] text-muted-foreground">({streamingMessages.length})</span>
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="message" className="flex-1 overflow-auto p-4 m-0">
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground font-mono mb-2">
              Request message as JSON. Use {'{{variable}}'} for environment variables.
            </p>
            {!validation.message.valid && validation.message.error && (
              <div className="text-xs text-destructive flex items-center gap-1 mb-2">
                <AlertCircle className="h-3 w-3" />
                {validation.message.error}
              </div>
            )}
            <CodeEditor
              value={grpcRequest.message || '{}'}
              onChange={handleMessageChange}
              language="json"
              height="400px"
            />
          </div>
        </TabsContent>

        <TabsContent value="metadata" className="flex-1 overflow-auto p-4 m-0">
          <p className="text-xs text-muted-foreground font-mono mb-3">
            gRPC metadata (headers). Common: authorization, content-type, grpc-timeout
          </p>
          <KeyValueEditor
            items={grpcRequest.metadata}
            onAdd={handleAddMetadata}
            onUpdate={handleUpdateMetadata}
            onDelete={handleDeleteMetadata}
            keyPlaceholder="Key (e.g., authorization)"
            valuePlaceholder="Value"
            addButtonText="Add Metadata"
            itemType="metadata"
          />
          {grpcRequest.auth.type !== 'none' && (
            <div className="mt-4 p-3 bg-surface-2 rounded border border-border">
              <div className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-1">
                Auth Metadata (auto-injected)
              </div>
              <pre className="text-xs text-muted-foreground whitespace-pre-wrap font-mono">
                {getAuthPreview()}
              </pre>
            </div>
          )}
        </TabsContent>

        <TabsContent value="auth" className="flex-1 overflow-auto p-4 m-0">
          <p className="text-xs text-muted-foreground font-mono mb-4">
            Authentication will be automatically converted to gRPC metadata.
          </p>
          <AuthConfiguration auth={grpcRequest.auth} onChange={handleAuthChange} />
        </TabsContent>

        <TabsContent value="scripts" className="flex-1 overflow-auto m-0">
          <ScriptsEditor
            preRequestScript={grpcRequest.preRequestScript || ''}
            testScript={grpcRequest.testScript || ''}
            onPreRequestScriptChange={(script) => updateRequest({ preRequestScript: script })}
            onTestScriptChange={(script) => updateRequest({ testScript: script })}
          />
        </TabsContent>

        <TabsContent value="settings" className="flex-1 overflow-auto p-4 m-0">
          <div className="space-y-6 max-w-sm">
            <div className="space-y-3">
              <p className="text-xs font-mono text-muted-foreground uppercase tracking-widest">Retry Policy</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-muted-foreground font-mono mb-1 block">Max Attempts</label>
                  <Input
                    type="number"
                    min={1}
                    max={10}
                    value={retryMaxAttempts}
                    onChange={(e) => setRetryMaxAttempts(Math.max(1, Math.min(10, parseInt(e.target.value, 10) || 1)))}
                    className="h-7 text-xs font-mono"
                  />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground font-mono mb-1 block">Retry Delay (ms)</label>
                  <Input
                    type="number"
                    min={0}
                    step={500}
                    value={retryDelayMs}
                    onChange={(e) => setRetryDelayMs(Math.max(0, parseInt(e.target.value, 10) || 0))}
                    className="h-7 text-xs font-mono"
                  />
                </div>
              </div>
              {retryMaxAttempts > 1 && (
                <p className="text-[11px] text-muted-foreground font-mono">
                  Will retry up to {retryMaxAttempts - 1} time{retryMaxAttempts > 2 ? 's' : ''} on failure, waiting {retryDelayMs}ms between attempts.
                </p>
              )}
            </div>
            <div className="space-y-3">
              <p className="text-xs font-mono text-muted-foreground uppercase tracking-widest">Compression</p>
              <div className="flex items-center gap-3">
                <input
                  id="use-compression"
                  type="checkbox"
                  checked={useCompression}
                  onChange={(e) => setUseCompression(e.target.checked)}
                  className="h-4 w-4 rounded border-border"
                />
                <label htmlFor="use-compression" className="text-xs font-mono cursor-pointer">
                  Send gzip-compressed requests
                </label>
              </div>
              {useCompression && !isElectron() && (
                <p className="text-[11px] text-amber-400 font-mono">
                  Compression is only supported in the Electron desktop app.
                </p>
              )}
            </div>
          </div>
        </TabsContent>

        {streamingMessages.length > 0 && (
          <TabsContent value="streaming" className="flex-1 overflow-auto p-4 m-0">
            <GrpcStreamingMessages messages={streamingMessages} />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}

export default withErrorBoundary(GrpcRequestBuilder);
