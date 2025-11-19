'use client';

import { useState, useCallback, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useRequestStore } from '@/store/useRequestStore';
import { useHistoryStore } from '@/store/useHistoryStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import {
  KeyValue,
  AuthConfig as AuthConfigType,
  GrpcMethodType,
  GrpcRequest,
  ProtoFileInfo,
} from '@/types';
import { Send, Plus, Trash2, Upload, FileText, AlertCircle, CheckCircle, Loader2, Radio } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import AuthConfiguration from '@/components/AuthConfig';
import dynamic from 'next/dynamic';
import {
  validateMethodName,
  getMethodTypeDescription,
  GrpcClientError,
  buildAuthMetadata,
  makeElectronGrpcRequest,
  startElectronGrpcStream,
  parseProtoFile,
  validateGrpcUrl,
  validateServiceName,
  createErrorResponse,
} from '@/lib/grpcClient';
import {
  GrpcReflectionClient,
  generateRequestTemplate,
  formatMessageSchemaForDisplay,
} from '@/lib/grpcReflection';
import { toast } from 'sonner';
import { ReflectionServiceInfo, ReflectionMethodInfo, ReflectionResult } from '@/types';

const CodeEditor = dynamic(() => import('@/components/CodeEditor'), { ssr: false });

interface ValidationState {
  url: { valid: boolean; error?: string };
  service: { valid: boolean; error?: string };
  method: { valid: boolean; error?: string };
  message: { valid: boolean; error?: string };
}

export default function GrpcRequestBuilder() {
  const { currentRequest, updateRequest, setLoading, setCurrentResponse, isLoading } = useRequestStore();
  const { addHistoryItem } = useHistoryStore();
  const { resolveVariables } = useEnvironmentStore();
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

  // Reflection state
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [reflectionResult, setReflectionResult] = useState<ReflectionResult | null>(null);
  const [selectedReflectionService, setSelectedReflectionService] = useState<ReflectionServiceInfo | null>(null);
  const [selectedReflectionMethod, setSelectedReflectionMethod] = useState<ReflectionMethodInfo | null>(null);
  const [showSchemaInfo, setShowSchemaInfo] = useState(false);

  if (!currentRequest || currentRequest.type !== 'grpc') {
    return null;
  }

  const grpcRequest = currentRequest as GrpcRequest;

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
    try {
      JSON.parse(message);
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

  const handleAddMetadata = () => {
    const newMetadata: KeyValue = {
      id: uuidv4(),
      key: '',
      value: '',
      enabled: true,
    };
    updateRequest({ metadata: [...grpcRequest.metadata, newMetadata] });
  };

  const handleUpdateMetadata = (id: string, updates: Partial<KeyValue>) => {
    updateRequest({
      metadata: grpcRequest.metadata.map((m) => (m.id === id ? { ...m, ...updates } : m)),
    });
  };

  const handleDeleteMetadata = (id: string) => {
    updateRequest({
      metadata: grpcRequest.metadata.filter((m) => m.id !== id),
    });
  };

  const handleAuthChange = (auth: AuthConfigType) => {
    updateRequest({ auth });
  };

  const handleDiscoverServices = useCallback(async (silent = false) => {
    if (!grpcRequest.url) {
      if (!silent) {
        toast.error('URL required', {
          description: 'Please enter a gRPC server URL before discovering services',
        });
      }
      return;
    }

    const urlValidation = validateGrpcUrl(grpcRequest.url);
    if (!urlValidation.valid) {
      if (!silent) {
        toast.error('Invalid URL', {
          description: urlValidation.error,
        });
      }
      return;
    }

    setIsDiscovering(true);
    // Don't clear result immediately on auto-discovery to avoid flickering if it fails
    if (!silent) {
      setReflectionResult(null);
      setSelectedReflectionService(null);
      setSelectedReflectionMethod(null);
    }

    try {
      const resolvedUrl = resolveVariables(grpcRequest.url);
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
          const firstService = result.services[0]!;
          setSelectedReflectionService(firstService);
          handleSelectReflectionService(firstService);

          if (firstService.methods.length > 0) {
            const firstMethod = firstService.methods[0]!;
            setSelectedReflectionMethod(firstMethod);
            handleSelectReflectionMethod(firstMethod);
          }
        }
      } else {
        if (!silent) {
          toast.error('Discovery failed', {
            description: result.error || 'Failed to discover services via reflection',
          });
        }
        // If silent (auto) and failed, we don't update state to error, just keep previous or null
        if (!silent) {
           setReflectionResult({
            success: false,
            services: [],
            error: result.error,
            serverUrl: grpcRequest.url,
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
          serverUrl: grpcRequest.url,
          timestamp: Date.now(),
        });
      }
    } finally {
      setIsDiscovering(false);
    }
  }, [grpcRequest.url, resolveVariables]);

  // Auto-discover services when URL changes
  useEffect(() => {
    if (!grpcRequest.url) return;
    const { valid } = validateGrpcUrl(grpcRequest.url);
    if (!valid) return;

    // Debounce discovery
    const timer = setTimeout(() => {
      // Only discover if we haven't already or if it's a new URL
      if (reflectionResult?.serverUrl !== grpcRequest.url) {
        handleDiscoverServices(true);
      }
    }, 1500);

    return () => clearTimeout(timer);
  }, [grpcRequest.url, handleDiscoverServices, reflectionResult?.serverUrl]);

  const handleSelectReflectionService = (service: ReflectionServiceInfo) => {
    setSelectedReflectionService(service);
    updateRequest({ service: service.fullName });
    validateService(service.fullName);

    // Clear method selection when service changes
    setSelectedReflectionMethod(null);
  };

  const handleSelectReflectionMethod = (method: ReflectionMethodInfo) => {
    setSelectedReflectionMethod(method);
    updateRequest({ method: method.name });
    validateMethod(method.name);

    // Set method type based on streaming config
    let methodType: GrpcMethodType = 'unary';
    if (method.clientStreaming && method.serverStreaming) {
      methodType = 'bidirectional-streaming';
    } else if (method.serverStreaming) {
      methodType = 'server-streaming';
    } else if (method.clientStreaming) {
      methodType = 'client-streaming';
    }
    updateRequest({ methodType });

    // Generate request template from schema
    if (method.inputMessageSchema && method.inputMessageSchema.fields.length > 0) {
      const template = generateRequestTemplate(method.inputMessageSchema);
      updateRequest({ message: template });
      validateMessage(template);

      toast.info('Request template generated', {
        description: `Generated template for ${method.inputMessageSchema.name}`,
      });
    }
  };

  const handleProtoUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!file.name.endsWith('.proto')) {
      toast.error('Invalid file type', {
        description: 'Please upload a .proto file',
      });
      return;
    }

    setProtoFile(file);

    try {
      const content = await file.text();
      const parsed = parseProtoFile(content);
      setProtoInfo(parsed);

      // Auto-fill service if available
      if (parsed.services.length > 0) {
        const firstService = parsed.services[0]!;
        updateRequest({ service: firstService.fullName });
        validateService(firstService.fullName);

        // Auto-fill first method if available
        if (firstService.methods.length > 0) {
          const firstMethod = firstService.methods[0]!;
          updateRequest({ method: firstMethod.name });
          validateMethod(firstMethod.name);

          // Set method type based on streaming config
          let methodType: GrpcMethodType = 'unary';
          if (firstMethod.clientStreaming && firstMethod.serverStreaming) {
            methodType = 'bidirectional-streaming';
          } else if (firstMethod.serverStreaming) {
            methodType = 'server-streaming';
          } else if (firstMethod.clientStreaming) {
            methodType = 'client-streaming';
          }
          updateRequest({ methodType });
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
      setProtoInfo(null);
    }
  };

  const handleSendRequest = async () => {
    // Validate all fields
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

    setLoading(true);
    setStreamingMessages([]);
    const startTime = Date.now();

    try {
      // Check if we have a proto file
      if (!protoFile) {
        toast.error('Proto file required', {
          description: 'Please upload a .proto file to send requests.',
        });
        setLoading(false);
        return;
      }

      const protoContent = await protoFile.text();

      // Handle streaming requests
      if (grpcRequest.methodType !== 'unary') {
        const control = startElectronGrpcStream(
          grpcRequest,
          protoContent,
          protoFile.name,
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
              if (s.status === 0) {
                toast.success('Stream completed');
              }
              setLoading(false);
              setStreamControl(null);
            }
          }
        );
        setStreamControl(control);
        return;
      }

      // Handle Unary requests
      const response = await makeElectronGrpcRequest(
        grpcRequest,
        protoContent,
        protoFile.name,
        resolveVariables
      );

      setCurrentResponse(response);
      addHistoryItem(grpcRequest, response);

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
      const errorResponse = createErrorResponse(grpcRequest.id, error, startTime);
      setCurrentResponse(errorResponse);
      addHistoryItem(grpcRequest, errorResponse);

      if (error instanceof GrpcClientError) {
        toast.error(`gRPC Error: ${error.statusCode}`, {
          description: error.message,
        });
      } else {
        const errorMessage = error instanceof Error ? error.message : 'gRPC request failed';
        toast.error('Request failed', {
          description: errorMessage,
        });
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
    if (Object.keys(authMetadata).length === 0) {
      return 'No authentication configured';
    }
    return Object.entries(authMetadata)
      .map(([key, value]) => {
        // Mask sensitive values
        const maskedValue = key.includes('authorization') || key.includes('password')
          ? value.substring(0, 10) + '...'
          : value;
        return `${key}: ${maskedValue}`;
      })
      .join('\n');
  };

  return (
    <div className="flex-1 flex flex-col border-b border-white/10 dark:border-white/5">
      {/* Request Line */}
      <div className="p-4 border-b border-white/10 dark:border-white/5 space-y-2">
        <div className="flex gap-2">
          <Select
            value={grpcRequest.methodType}
            onValueChange={(value) => handleMethodTypeChange(value as GrpcMethodType)}
          >
            <SelectTrigger className="w-48 glass-subtle border-white/10 dark:border-white/5">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="unary">Unary</SelectItem>
              <SelectItem value="server-streaming">Server Streaming</SelectItem>
              <SelectItem value="client-streaming">Client Streaming</SelectItem>
              <SelectItem value="bidirectional-streaming">Bidirectional</SelectItem>
            </SelectContent>
          </Select>

          <div className="flex-1 relative">
            <Input
              value={grpcRequest.url}
              onChange={(e) => handleUrlChange(e.target.value)}
              placeholder="Enter gRPC server URL (e.g., https://api.example.com)"
              className={`flex-1 glass-subtle border-white/10 dark:border-white/5 ${!validation.url.valid ? 'border-red-500' : ''}`}
            />
            {!validation.url.valid && validation.url.error && (
              <div className="text-xs text-red-500 mt-1 flex items-center gap-1">
                <AlertCircle className="h-3 w-3" />
                {validation.url.error}
              </div>
            )}
          </div>

          <Button onClick={handleSendRequest} disabled={isLoading && !streamControl || !isFormValid()}>
            <Send className="mr-2 h-4 w-4" />
            {isLoading ? 'Invoking...' : 'Invoke'}
          </Button>
          
          {streamControl && (
            <Button variant="destructive" onClick={() => {
              streamControl.cancelStream();
              setStreamControl(null);
              setLoading(false);
            }}>
              Cancel Stream
            </Button>
          )}
        </div>

        <div className="flex gap-2">
          <div className="flex-1 relative">
            {reflectionResult?.success && reflectionResult.services.length > 0 ? (
              <Select
                value={selectedReflectionService?.fullName || ''}
                onValueChange={(value) => {
                  const service = reflectionResult.services.find((s) => s.fullName === value);
                  if (service) handleSelectReflectionService(service);
                }}
              >
                <SelectTrigger className={`glass-subtle border-white/10 dark:border-white/5 ${!validation.service.valid ? 'border-red-500' : ''}`}>
                  <SelectValue placeholder="Select service" />
                </SelectTrigger>
                <SelectContent>
                  {reflectionResult.services.filter(s => s.fullName).map((service) => (
                    <SelectItem key={service.fullName} value={service.fullName}>
                      {service.fullName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                value={grpcRequest.service}
                onChange={(e) => handleServiceChange(e.target.value)}
                placeholder="Service name (e.g., greet.v1.GreetService)"
                className={`glass-subtle border-white/10 dark:border-white/5 ${!validation.service.valid ? 'border-red-500' : ''}`}
              />
            )}
            {!validation.service.valid && validation.service.error && (
              <div className="text-xs text-red-500 mt-1 flex items-center gap-1">
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
                <SelectTrigger className={`glass-subtle border-white/10 dark:border-white/5 ${!validation.method.valid ? 'border-red-500' : ''}`}>
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
            ) : (
              <Input
                value={grpcRequest.method}
                onChange={(e) => handleMethodChange(e.target.value)}
                placeholder="Method name (e.g., Greet)"
                className={`glass-subtle border-white/10 dark:border-white/5 ${!validation.method.valid ? 'border-red-500' : ''}`}
              />
            )}
            {!validation.method.valid && validation.method.error && (
              <div className="text-xs text-red-500 mt-1 flex items-center gap-1">
                <AlertCircle className="h-3 w-3" />
                {validation.method.error}
              </div>
            )}
          </div>

          <Button
            variant="outline"
            onClick={() => handleDiscoverServices(false)}
            disabled={isDiscovering || !grpcRequest.url}
            title="Discover services via gRPC reflection"
          >
            {isDiscovering ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Radio className="mr-2 h-4 w-4" />
            )}
            {isDiscovering ? 'Discovering...' : 'Discover'}
          </Button>

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
        </div>

        {/* Method type description */}
        <div className="text-xs text-muted-foreground">
          {getMethodTypeDescription(grpcRequest.methodType)}
        </div>

        {/* Reflection result info */}
        {reflectionResult && (
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
                {selectedReflectionMethod && (
                  <div className="mt-2">
                    <div className="font-medium">Selected Method:</div>
                    <div>
                      Input: {selectedReflectionMethod.inputType.split('.').pop()} | Output:{' '}
                      {selectedReflectionMethod.outputType.split('.').pop()}
                    </div>
                    <Button
                      variant="link"
                      size="sm"
                      className="p-0 h-auto text-xs"
                      onClick={() => setShowSchemaInfo(!showSchemaInfo)}
                    >
                      {showSchemaInfo ? 'Hide Schema' : 'Show Schema'}
                    </Button>
                    {showSchemaInfo && selectedReflectionMethod.inputMessageSchema && (
                      <pre className="mt-1 p-2 bg-muted rounded text-xs overflow-x-auto">
                        {formatMessageSchemaForDisplay(selectedReflectionMethod.inputMessageSchema)}
                      </pre>
                    )}
                  </div>
                )}
              </>
            ) : (
              <div className="text-red-600 dark:text-red-400">{reflectionResult.error}</div>
            )}
          </div>
        )}

        {/* Proto file info */}
        {protoInfo && (
          <div className="bg-white/5 dark:bg-white/5 p-2 rounded text-xs space-y-1 border border-white/10 dark:border-white/5">
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
        )}
      </div>

      {/* Request Details Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col">
        <div className="px-4 py-2 border-b bg-muted/20">
          <TabsList className="h-9 w-full justify-start bg-muted/50 p-1 text-muted-foreground">
            <TabsTrigger
              value="message"
              className="data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
            >
              Message
              {!validation.message.valid && (
                <AlertCircle className="ml-1 h-3 w-3 text-red-500" />
              )}
            </TabsTrigger>
            <TabsTrigger
              value="metadata"
              className="data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
            >
              Metadata
              <span className="ml-1 text-xs text-muted-foreground">
                ({grpcRequest.metadata.filter((m) => m.enabled).length})
              </span>
            </TabsTrigger>
            <TabsTrigger
              value="auth"
              className="data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
            >
              Auth
              {grpcRequest.auth.type !== 'none' && (
                <CheckCircle className="ml-1 h-3 w-3 text-green-500" />
              )}
            </TabsTrigger>
            {streamingMessages.length > 0 && (
              <TabsTrigger
                value="streaming"
                className="data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
              >
                Stream
                <span className="ml-1 text-xs text-muted-foreground">
                  ({streamingMessages.length})
                </span>
              </TabsTrigger>
            )}
          </TabsList>
        </div>

        <TabsContent value="message" className="flex-1 overflow-auto p-4">
          <div className="space-y-2">
            <div className="text-sm text-muted-foreground mb-2">
              Enter the request message as JSON. Use &#123;&#123;variable&#125;&#125; syntax for environment variables.
            </div>
            {!validation.message.valid && validation.message.error && (
              <div className="text-xs text-red-500 flex items-center gap-1 mb-2">
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

        <TabsContent value="metadata" className="flex-1 overflow-auto p-4">
          <div className="space-y-2">
            <div className="text-sm text-muted-foreground mb-2">
              Add gRPC metadata (headers) to your request. Common metadata: authorization, content-type,
              grpc-timeout
            </div>
            {grpcRequest.metadata.map((meta) => (
              <div key={meta.id} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={meta.enabled}
                  onChange={(e) => handleUpdateMetadata(meta.id, { enabled: e.target.checked })}
                  className="h-4 w-4"
                />
                <Input
                  value={meta.key}
                  onChange={(e) => handleUpdateMetadata(meta.id, { key: e.target.value })}
                  placeholder="Key (e.g., authorization)"
                  className="flex-1"
                />
                <Input
                  value={meta.value}
                  onChange={(e) => handleUpdateMetadata(meta.id, { value: e.target.value })}
                  placeholder="Value"
                  className="flex-1"
                />
                <Button variant="ghost" size="icon" onClick={() => handleDeleteMetadata(meta.id)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
            <Button onClick={handleAddMetadata} variant="outline" size="sm">
              <Plus className="mr-2 h-4 w-4" />
              Add Metadata
            </Button>

            {/* Auth metadata preview */}
            {grpcRequest.auth.type !== 'none' && (
              <div className="mt-4 p-3 bg-white/5 dark:bg-white/5 rounded border border-white/10 dark:border-white/5">
                <div className="text-xs font-medium mb-1">Auth Metadata (auto-injected)</div>
                <pre className="text-xs text-muted-foreground whitespace-pre-wrap">
                  {getAuthPreview()}
                </pre>
              </div>
            )}
          </div>
        </TabsContent>

        <TabsContent value="auth" className="flex-1 overflow-auto p-4">
          <div className="text-sm text-muted-foreground mb-4">
            Authentication will be automatically converted to gRPC metadata (headers).
          </div>
          <AuthConfiguration auth={grpcRequest.auth} onChange={handleAuthChange} />
        </TabsContent>

        {streamingMessages.length > 0 && (
          <TabsContent value="streaming" className="flex-1 overflow-auto p-4">
            <div className="space-y-2">
              <div className="text-sm text-muted-foreground mb-2">
                Streaming messages received: {streamingMessages.length}
              </div>
              <div className="space-y-2 max-h-96 overflow-y-auto">
                {streamingMessages.map((message, index) => (
                  <div key={index} className="bg-white/5 dark:bg-white/5 p-2 rounded border border-white/10 dark:border-white/5">
                    <div className="text-xs font-medium mb-1">Message {index + 1}</div>
                    <pre className="text-xs whitespace-pre-wrap">{message}</pre>
                  </div>
                ))}
              </div>
            </div>
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
