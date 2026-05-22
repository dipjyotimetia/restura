import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { Loader2, Radio } from 'lucide-react';
import { useRequestStore } from '@/store/useRequestStore';
import { useActiveRequest, useActiveResponse, useActiveTab } from '@/store/selectors';
import { useHistoryStore } from '@/store/useHistoryStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import type {
  AuthConfig as AuthConfigType,
  GrpcMethodType,
  GrpcRequest,
  GrpcResponse,
  ProtoFileInfo,
  ReflectionMethodInfo,
  ReflectionServiceInfo,
} from '@/types';
import AuthConfiguration from '@/features/auth/components/AuthConfig';
import {
  getMethodTypeDescription,
  GrpcClientError,
  buildAuthMetadata,
  startElectronGrpcStream,
  createErrorResponse,
} from '@/features/grpc/lib/grpcClient';
import {
  validateGrpcUrl,
  validateServiceField,
  validateMethodField,
  validateGrpcMessage,
  INITIAL_VALIDATION_STATE,
  type GrpcValidationState,
} from '@/features/grpc/lib/grpcValidation';
import { isElectron } from '@/lib/shared/platform';
import { useRequestRunner } from '@/features/registry/useRequestRunner';
import {
  generateRequestTemplate,
  generateProtoFromReflection,
  validateRequestAgainstSchema,
} from '@/features/grpc/lib/grpcReflection';
import { useGrpcReflection } from '@/features/grpc/hooks/useGrpcReflection';
import { toast } from 'sonner';
import { useKeyValueCollection } from '@/hooks/useKeyValueCollection';
import { withErrorBoundary } from '@/components/shared/ErrorBoundary';
import KeyValueEditor from '@/components/shared/KeyValueEditor';
import { GrpcStreamingMessages } from './GrpcStreamingControls';
import { GrpcStreamingPanel } from './GrpcStreamingPanel';
import { GrpcMessageEditor } from './GrpcMessageEditor';
import { GrpcMethodSelector } from './GrpcMethodSelector';
import { GrpcSettingsPanel } from './GrpcSettingsPanel';
import { GrpcInvocationBar } from './GrpcInvocationBar';
import { GrpcServiceTree } from './GrpcServiceTree';
import { GrpcMethodContext } from './GrpcMethodContext';
import { GrpcResponsePanel } from './GrpcResponsePanel';
import { Floater, SubTabBar, TextField } from '@/components/ui/spatial';
import { Button } from '@/components/ui/button';
import ScriptsEditor from '@/features/scripts/components/ScriptsEditor';

type GrpcSubTab =
  | 'message'
  | 'metadata'
  | 'auth'
  | 'settings'
  | 'scripts'
  | 'streaming'
  | 'web-stream';

function GrpcRequestBuilder() {
  const currentRequest = useActiveRequest('grpc');
  const activeTabId = useActiveTab()?.id;
  const activeResponse = useActiveResponse();
  const updateRequest = useRequestStore((s) => s.updateRequest);
  const setLoading = useRequestStore((s) => s.setLoading);
  const setCurrentResponse = useRequestStore((s) => s.setCurrentResponse);
  const setScriptResult = useRequestStore((s) => s.setScriptResult);
  const isLoading = useRequestStore((s) => s.isLoading);
  const { addHistoryItem } = useHistoryStore();
  const { resolveVariables } = useEnvironmentStore();
  const { run: runViaRegistry } = useRequestRunner();
  const [activeTab, setActiveTab] = useState<GrpcSubTab>('message');
  const [protoFile, setProtoFile] = useState<File | null>(null);
  const [protoInfo, setProtoInfo] = useState<ProtoFileInfo | null>(null);
  const [resolvedProto, setResolvedProto] = useState<{
    content: string;
    fileName: string;
  } | null>(null);
  const [validation, setValidation] = useState<GrpcValidationState>(INITIAL_VALIDATION_STATE);
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

  // Stable URL reference for use in callbacks and effects — must compute before early return
  const grpcUrl = currentRequest?.url;

  // All hooks must be called before any early return — Rules of Hooks
  const {
    handleAdd: handleAddMetadata,
    handleUpdate: handleUpdateMetadata,
    handleDelete: handleDeleteMetadata,
  } = useKeyValueCollection(
    currentRequest?.metadata ?? [],
    (metadata) => updateRequest({ metadata })
  );

  const validateUrl = useCallback((url: string) => {
    const result = validateGrpcUrl(url);
    setValidation((prev) => ({ ...prev, url: result }));
    return result.valid;
  }, []);

  const validateService = useCallback((service: string) => {
    const result = validateServiceField(service);
    setValidation((prev) => ({ ...prev, service: result }));
    return result.valid;
  }, []);

  const validateMethod = useCallback((method: string) => {
    const result = validateMethodField(method);
    setValidation((prev) => ({ ...prev, method: result }));
    return result.valid;
  }, []);

  const validateMessage = useCallback((message: string) => {
    const result = validateGrpcMessage(message);
    setValidation((prev) => ({ ...prev, message: result }));
    return result.valid;
  }, []);

  // Apply parent-side effects when the reflection hook surfaces a service
  // selection — push to the request store and re-run validators.
  const handleReflectionServiceSelected = useCallback(
    (service: ReflectionServiceInfo) => {
      updateRequest({ service: service.fullName });
      validateService(service.fullName);
    },
    [updateRequest, validateService]
  );

  // Apply parent-side effects when the reflection hook surfaces a method
  // selection — push name/methodType to the store, generate a request
  // template if the schema is known, and re-run validators. Template
  // generation lives here (not in the hook) because we own validateMessage
  // and the request store.
  const handleReflectionMethodSelected = useCallback(
    (method: ReflectionMethodInfo) => {
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
    },
    [updateRequest, validateMethod, validateMessage]
  );

  const reflection = useGrpcReflection({
    url: grpcUrl,
    resolveVariables,
    autoDiscover: !!currentRequest,
    onServiceSelected: handleReflectionServiceSelected,
    onMethodSelected: handleReflectionMethodSelected,
  });

  // Keep a ref so unmount cleanup always sees the current stream without re-running the effect
  const streamControlRef = useRef(streamControl);
  useEffect(() => {
    streamControlRef.current = streamControl;
  }, [streamControl]);

  useEffect(() => {
    return () => {
      try {
        streamControlRef.current?.cancelStream();
      } catch {
        /* ignore cleanup errors */
      }
    };
  }, []);

  const activeMetadataCount = currentRequest?.metadata.filter((m) => m.enabled).length ?? 0;
  const hasScripts =
    !!currentRequest?.preRequestScript?.trim() || !!currentRequest?.testScript?.trim();

  const subTabs = useMemo(() => {
    const tabs: Array<{
      value: GrpcSubTab;
      label: string;
      count?: number;
      badge?: string;
    }> = [
      { value: 'message', label: 'Message' },
      { value: 'metadata', label: 'Metadata', count: activeMetadataCount },
      {
        value: 'auth',
        label: 'Auth',
        ...(currentRequest?.auth.type && currentRequest.auth.type !== 'none'
          ? { badge: currentRequest.auth.type }
          : {}),
      },
      { value: 'settings', label: 'Settings' },
      { value: 'scripts', label: 'Scripts', ...(hasScripts ? { badge: 'on' } : {}) },
    ];
    if (streamingMessages.length > 0) {
      tabs.push({ value: 'streaming', label: 'Stream', count: streamingMessages.length });
    }
    if (currentRequest?.methodType && currentRequest.methodType !== 'unary') {
      tabs.push({ value: 'web-stream', label: 'Web Stream' });
    }
    return tabs;
  }, [
    activeMetadataCount,
    currentRequest?.auth.type,
    currentRequest?.methodType,
    hasScripts,
    streamingMessages.length,
  ]);

  if (!currentRequest) {
    return null;
  }

  const grpcRequest: GrpcRequest = currentRequest;
  const reflectionResult = reflection.result;
  const reflectionServices: ReflectionServiceInfo[] =
    reflectionResult?.success ? reflectionResult.services : [];

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

  const handleProtoUpload = (
    file: File,
    parsed: ProtoFileInfo,
    suggested: {
      service: string;
      method: string;
      methodType: GrpcMethodType;
    } | null
  ) => {
    setProtoFile(file);
    setProtoInfo(parsed);
    if (suggested) {
      updateRequest({
        service: suggested.service,
        method: suggested.method,
        methodType: suggested.methodType,
      });
      validateService(suggested.service);
      if (suggested.method) validateMethod(suggested.method);
    }
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
    if (reflection.selectedMethod?.inputMessageSchema && grpcRequest.message) {
      try {
        const parsed = JSON.parse(grpcRequest.message);
        const schemaValidation = validateRequestAgainstSchema(
          parsed,
          reflection.selectedMethod.inputMessageSchema
        );
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

    try {
      let protoContent: string;
      let protoFileName: string;

      if (protoFile) {
        protoContent = await protoFile.text();
        protoFileName = protoFile.name;
      } else if (reflection.result?.success && reflection.selectedService) {
        protoContent = generateProtoFromReflection(
          grpcRequest.service,
          reflection.selectedService
        );
        protoFileName = 'generated.proto';
      } else {
        toast.error('Proto file or reflection required', {
          description:
            'Please upload a .proto file or use a server with gRPC reflection enabled.',
        });
        setLoading(false);
        return;
      }

      setResolvedProto({ content: protoContent, fileName: protoFileName });

      if (grpcRequest.methodType !== 'unary') {
        // Streaming paths stay on the bespoke Electron IPC stream — the
        // registry runner doesn't model long-lived streams yet
        // (TODO(registry-streaming) on grpcProtocol).
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

      // Unary path: route through the registry runner. The gRPC protocol
      // module handles transport selection (Electron vs proxy), pre/test
      // scripts, and history persistence — Electron requires proto bytes
      // via protocolOptions which the proxy ignores.
      const protocolOptions = {
        protoContent,
        protoFileName,
        timeoutMs,
        useCompression,
      };

      const runOnce = () => runViaRegistry(grpcRequest, 'grpc', { protocolOptions });

      let { response, scriptResult } = await runOnce();
      let grpcResponse = response as GrpcResponse;

      // Retry on non-OK status if retry policy configured. We bypass the
      // runner's history hook on retry attempts by re-running the full
      // pipeline — addHistoryItem dedups on (request,response) timestamp
      // so each attempt shows up. Mirrors the previous inline behavior.
      for (
        let attempt = 2;
        attempt <= retryMaxAttempts && grpcResponse.grpcStatus !== 0;
        attempt++
      ) {
        if (retryDelayMs > 0) {
          await new Promise((r) => setTimeout(r, retryDelayMs));
        }
        toast.info(`Retrying... (attempt ${attempt}/${retryMaxAttempts})`);
        ({ response, scriptResult } = await runOnce());
        grpcResponse = response as GrpcResponse;
      }

      setCurrentResponse(grpcResponse);
      // The runner already pushed scriptResult into the active tab via
      // ctx.onScriptResult — no additional setScriptResult call needed.
      void scriptResult;

      if (grpcResponse.grpcStatus === 0) {
        toast.success('Request completed', {
          description: `${grpcRequest.methodType} call to ${grpcRequest.service}/${grpcRequest.method}`,
        });
        if (grpcResponse.messages) {
          setStreamingMessages(grpcResponse.messages);
        }
      } else {
        toast.error(`gRPC Error: ${grpcResponse.grpcStatus}`, {
          description: grpcResponse.grpcStatusText || 'Unknown error',
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
        const errorMessage =
          error instanceof Error ? error.message : 'gRPC request failed';
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

  // Cast active response to GrpcResponse if it carries grpc fields. We can't
  // narrow at the store level (the slot is ApiResponse), so coerce here.
  const grpcResponse =
    activeResponse && 'grpcStatus' in activeResponse
      ? (activeResponse as GrpcResponse)
      : null;

  return (
    <div className="flex-1 flex flex-col min-h-0 p-2.5 gap-2.5">
      {/* Method + URL invocation bar (full width) */}
      <GrpcInvocationBar
        methodType={grpcRequest.methodType}
        url={grpcRequest.url}
        isLoading={isLoading}
        isFormValid={!!isFormValid()}
        streamControl={streamControl}
        urlError={validation.url.error}
        isUrlValid={validation.url.valid}
        onMethodTypeChange={handleMethodTypeChange}
        onUrlChange={handleUrlChange}
        onSend={handleSendRequest}
        onCancelStream={() => {
          streamControl?.cancelStream();
          setStreamControl(null);
          setLoading(false);
        }}
      />

      {/* 3-column grid: service tree (280px) · center · response */}
      <div
        className="flex-1 grid gap-2.5 min-h-0"
        style={{ gridTemplateColumns: '280px 1fr 1.1fr' }}
      >
        {/* Left column: Service Tree */}
        <GrpcServiceTree
          services={reflectionServices}
          selectedService={reflection.selectedService}
          selectedMethod={reflection.selectedMethod}
          reflectionReady={!!reflectionResult?.success}
          reflectionLoading={reflection.loading}
          protoInfo={protoInfo}
          onSelectService={reflection.selectService}
          onSelectMethod={reflection.selectMethod}
          onProtoUpload={handleProtoUpload}
        />

        {/* Center column: method context + tabs + body */}
        <div className="flex flex-col gap-2.5 min-h-0">
          <GrpcMethodContext
            methodName={grpcRequest.method}
            methodType={grpcRequest.methodType}
            selectedMethod={reflection.selectedMethod}
            showSchema={reflection.showSchema}
            onToggleSchema={() => reflection.setShowSchema(!reflection.showSchema)}
          />

          <Floater
            radius="panel"
            elevation="float-lg"
            className="flex-1 flex flex-col min-h-0 overflow-hidden"
            style={{ background: 'var(--sp-surface)' }}
          >
            <SubTabBar<GrpcSubTab>
              tabs={subTabs}
              value={activeTab}
              onChange={setActiveTab}
              right={
                <div className="flex items-center gap-2 py-1.5">
                  <span className="sp-label">Timeout (ms)</span>
                  <TextField
                    mono
                    size="sm"
                    type="number"
                    value={timeoutMs}
                    onChange={(e) =>
                      setTimeoutMs(
                        Math.max(1000, parseInt(e.target.value, 10) || 30000)
                      )
                    }
                    min={1000}
                    step={1000}
                    aria-label="gRPC request timeout in milliseconds"
                    className="w-24"
                  />
                </div>
              }
            />

            {/* Inline service/method picker — kept available so users can edit
                service/method names directly. Reflection drives the dropdown,
                free-text takes over when reflection is unavailable. */}
            <div className="flex gap-2 px-3 py-2 border-b border-sp-line">
              <GrpcMethodSelector
                services={reflectionServices}
                selectedService={reflection.selectedService}
                selectedMethod={reflection.selectedMethod}
                serviceValue={grpcRequest.service}
                methodValue={grpcRequest.method}
                serviceValidation={validation.service}
                methodValidation={validation.method}
                onSelectService={reflection.selectService}
                onSelectMethod={reflection.selectMethod}
                onServiceTextChange={handleServiceChange}
                onMethodTextChange={handleMethodChange}
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => reflection.discover(false)}
                disabled={reflection.loading || !grpcRequest.url}
                title="Discover services via gRPC reflection"
                className="h-8 shrink-0 text-sp-12"
              >
                {reflection.loading ? (
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Radio className="mr-1.5 h-3.5 w-3.5" />
                )}
                {reflection.loading ? 'Discovering…' : 'Discover'}
              </Button>
            </div>

            <div className="text-sp-11 font-mono text-sp-muted px-3 py-1.5 border-b border-sp-line">
              {getMethodTypeDescription(grpcRequest.methodType)}
            </div>

            <div className="flex-1 min-h-0 overflow-auto">
              {activeTab === 'message' && (
                <div className="p-3">
                  <GrpcMessageEditor
                    value={grpcRequest.message}
                    onChange={handleMessageChange}
                    error={validation.message.error}
                    isValid={validation.message.valid}
                    {...(activeTabId
                      ? { editorPath: `tab-${activeTabId}-grpc-message` }
                      : {})}
                  />
                </div>
              )}

              {activeTab === 'metadata' && (
                <div className="p-3 space-y-3">
                  <p className="text-sp-11 text-sp-muted font-mono">
                    gRPC metadata (headers). Common: authorization, content-type,
                    grpc-timeout
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
                    <div className="p-3 rounded-sp-btn border border-sp-line bg-sp-surface-lo">
                      <div className="sp-label mb-1">Auth Metadata (auto-injected)</div>
                      <pre className="text-sp-11 text-sp-muted whitespace-pre-wrap font-mono">
                        {getAuthPreview()}
                      </pre>
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'auth' && (
                <div className="p-3 space-y-3">
                  <p className="text-sp-11 text-sp-muted font-mono">
                    Authentication will be automatically converted to gRPC metadata.
                  </p>
                  <AuthConfiguration auth={grpcRequest.auth} onChange={handleAuthChange} />
                </div>
              )}

              {activeTab === 'settings' && (
                <div className="p-3">
                  <GrpcSettingsPanel
                    retryMaxAttempts={retryMaxAttempts}
                    retryDelayMs={retryDelayMs}
                    useCompression={useCompression}
                    onRetryMaxAttemptsChange={setRetryMaxAttempts}
                    onRetryDelayMsChange={setRetryDelayMs}
                    onUseCompressionChange={setUseCompression}
                  />
                </div>
              )}

              {activeTab === 'scripts' && (
                <ScriptsEditor
                  preRequestScript={grpcRequest.preRequestScript || ''}
                  testScript={grpcRequest.testScript || ''}
                  onPreRequestScriptChange={(script) =>
                    updateRequest({ preRequestScript: script })
                  }
                  onTestScriptChange={(script) =>
                    updateRequest({ testScript: script })
                  }
                />
              )}

              {activeTab === 'streaming' && streamingMessages.length > 0 && (
                <div className="p-3">
                  <GrpcStreamingMessages messages={streamingMessages} />
                </div>
              )}

              {activeTab === 'web-stream' && grpcRequest.methodType !== 'unary' && (
                <GrpcStreamingPanel
                  request={grpcRequest}
                  {...(resolvedProto?.content
                    ? { protoContent: resolvedProto.content }
                    : {})}
                  {...(resolvedProto?.fileName
                    ? { protoFileName: resolvedProto.fileName }
                    : {})}
                />
              )}
            </div>
          </Floater>
        </div>

        {/* Right column: response panel */}
        <GrpcResponsePanel response={grpcResponse} isLoading={isLoading} />
      </div>
    </div>
  );
}

export default withErrorBoundary(GrpcRequestBuilder);
