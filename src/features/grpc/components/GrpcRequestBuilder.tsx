import { AlertCircle, Loader2, Radio } from 'lucide-react';
import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { toast } from 'sonner';
import { v4 as uuidv4 } from 'uuid';
import { GrpcInvocationBar } from './GrpcInvocationBar';
import { GrpcMessageEditor } from './GrpcMessageEditor';
import { GrpcMethodContext } from './GrpcMethodContext';
import { GrpcMethodSelector } from './GrpcMethodSelector';
import GrpcProtoUploader from './GrpcProtoUploader';
import { GrpcSettingsPanel } from './GrpcSettingsPanel';
import { GrpcStreamingMessages } from './GrpcStreamingControls';
import { GrpcStreamingPanel } from './GrpcStreamingPanel';
import { withErrorBoundary } from '@/components/shared/ErrorBoundary';
import KeyValueEditor from '@/components/shared/KeyValueEditor';
import { Button } from '@/components/ui/button';
import { Floater, SubTabBar, TextField } from '@/components/ui/spatial';
import AuthConfiguration from '@/features/auth/components/AuthConfig';
import { InheritedAuthHint } from '@/features/auth/components/InheritedAuthHint';
import { useGrpcReflection } from '@/features/grpc/hooks/useGrpcReflection';
import {
  getMethodTypeDescription,
  GrpcClientError,
  buildAuthMetadata,
  createErrorResponse,
} from '@/features/grpc/lib/grpcClient';
import {
  generateRequestTemplate,
  generateProtoFromReflection,
  validateRequestAgainstSchema,
} from '@/features/grpc/lib/grpcReflection';
import { startGrpcStream } from '@/features/grpc/lib/grpcStreamingClient';
import {
  validateGrpcUrl,
  validateServiceField,
  validateMethodField,
  validateGrpcMessage,
  INITIAL_VALIDATION_STATE,
  type GrpcValidationState,
} from '@/features/grpc/lib/grpcValidation';
import { useRequestRunner } from '@/features/registry/useRequestRunner';
import ScriptsEditor from '@/features/scripts/components/ScriptsEditor';
import { useKeyValueCollection } from '@/hooks/useKeyValueCollection';
import { isElectron } from '@/lib/shared/platform';
import { useActiveRequest, useActiveTab } from '@/store/selectors';
import { useConsoleStore, createProtocolConsoleEntry } from '@/store/useConsoleStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useHistoryStore } from '@/store/useHistoryStore';
import { useRequestStore } from '@/store/useRequestStore';
import { GrpcStatusCodeName } from '@/types';
import type {
  AuthConfig as AuthConfigType,
  GrpcMethodType,
  GrpcRequest,
  GrpcResponse,
  GrpcStatusCode,
  ReflectionMethodInfo,
  ReflectionServiceInfo,
} from '@/types';

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
  } = useKeyValueCollection(currentRequest?.metadata ?? [], (metadata) =>
    updateRequest({ metadata })
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
  const reflectionServices: ReflectionServiceInfo[] = reflectionResult?.success
    ? reflectionResult.services
    : [];

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
      // Raw reflection descriptors (Electron only) — preferred over the
      // reconstructed `.proto` text, which is lossy (drops enums / well-known
      // types / maps / oneofs). The text is still generated for display + the
      // web Connect path; Electron loads the descriptor set instead.
      let descriptors: string[] | undefined;

      if (protoFile) {
        protoContent = await protoFile.text();
        protoFileName = protoFile.name;
      } else if (reflection.result?.success && reflection.selectedService) {
        descriptors = reflection.selectedService.descriptors;
        protoContent = generateProtoFromReflection(grpcRequest.service, reflection.selectedService);
        protoFileName = 'generated.proto';
      } else {
        toast.error('Proto file or reflection required', {
          description: 'Please upload a .proto file or use a server with gRPC reflection enabled.',
        });
        setLoading(false);
        return;
      }

      setResolvedProto({ content: protoContent, fileName: protoFileName });

      if (grpcRequest.methodType !== 'unary') {
        // Streaming paths stay on the bespoke startGrpcStream handle — the
        // registry runner doesn't model long-lived streams yet
        // (TODO(registry-streaming) on grpcProtocol). This builder gates
        // streaming to Electron; the web Connect path lives in
        // GrpcStreamingPanel (the "Web Stream" tab).
        if (!isElectron()) {
          toast.error('Streaming gRPC requires the desktop app', {
            description: 'Unary requests are supported in the browser via the proxy.',
          });
          setLoading(false);
          return;
        }
        const handle = await startGrpcStream({
          request: grpcRequest,
          resolveVariables,
          protoContent,
          protoFileName,
          ...(descriptors?.length ? { descriptors } : {}),
          timeoutMs,
          useCompression,
        });
        // Mirror streaming traffic into the unified console Frames tab — the
        // bespoke streaming handle never routed through the runner, so before
        // this gRPC streams were invisible in the console (only the in-panel
        // message list showed them). One connection id per invocation groups
        // a single stream's frames together; the label is the called method.
        const streamLabel = `${grpcRequest.service}/${grpcRequest.method}`;
        const streamConnId = `grpc-${uuidv4().slice(0, 8)}`;
        const streamFrame = (direction: 'in' | 'out' | 'system', payload: string) =>
          useConsoleStore.getState().addFrame({
            timestamp: Date.now(),
            protocol: 'grpc',
            direction,
            connectionId: streamConnId,
            label: streamLabel,
            payload,
            bytes: new TextEncoder().encode(payload).length,
          });
        streamFrame('system', `stream opened — ${grpcRequest.methodType}`);
        // Adapt the async-iterator handle to the streamControl shape the
        // invocation bar / streaming controls already consume.
        setStreamControl({
          sendMessage: (msg: unknown) => {
            streamFrame('out', typeof msg === 'string' ? msg : JSON.stringify(msg, null, 2));
            void handle.send(msg);
          },
          endStream: () => handle.closeSend(),
          cancelStream: () => handle.cancel(),
        });
        // Drain inbound messages as they arrive, then settle on the final gRPC
        // status. The iterator throws if the stream errors; `done` always
        // resolves (carrying the status + trailers), so the error is reported
        // once, from the catch.
        void (async () => {
          try {
            for await (const msg of handle.messages) {
              const text = JSON.stringify(msg, null, 2);
              setStreamingMessages((prev) => [...prev, text]);
              streamFrame('in', text);
            }
            const final = await handle.done;
            if (final.status === 0) {
              streamFrame('system', 'stream completed — OK');
              toast.success('Stream completed');
            } else {
              const description =
                final.statusMessage ||
                GrpcStatusCodeName[final.status as GrpcStatusCode] ||
                'Stream error';
              streamFrame('system', `stream closed — ${final.status} ${description}`);
              toast.error(`gRPC Error: ${final.status}`, { description });
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            streamFrame('system', `stream error — ${message}`);
            toast.error('gRPC stream error', { description: message });
          } finally {
            setLoading(false);
            setStreamControl(null);
          }
        })();
        return;
      }

      // Unary path: route through the registry runner. The gRPC protocol
      // module handles transport selection (Electron vs proxy), pre/test
      // scripts, and history persistence — Electron requires proto bytes
      // via protocolOptions which the proxy ignores.
      const protocolOptions = {
        protoContent,
        protoFileName,
        ...(descriptors?.length ? { descriptors } : {}),
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

      // Mirror the final attempt into the unified console (interactive sends
      // previously only appeared when run via a collection). Retried attempts
      // are intentionally not mirrored — one entry per user action.
      const consoleLogs = [
        ...(scriptResult?.preRequest?.logs ?? []),
        ...(scriptResult?.test?.logs ?? []),
      ];
      const consoleTests = (scriptResult?.test?.tests ?? []).map((t) => ({
        name: t.name,
        passed: t.passed,
        ...(t.error ? { error: t.error } : {}),
      }));
      const sentMetadata: Record<string, string> = {};
      for (const m of grpcRequest.metadata) {
        if (m.enabled && m.key) sentMetadata[m.key] = m.value;
      }
      useConsoleStore.getState().addEntry(
        createProtocolConsoleEntry({
          protocol: 'grpc',
          method: `${grpcRequest.service}/${grpcRequest.method}`,
          url: grpcRequest.url,
          headers: sentMetadata,
          ...(grpcRequest.message ? { body: grpcRequest.message } : {}),
          response: grpcResponse,
          ...(consoleLogs.length > 0 && { scriptLogs: consoleLogs }),
          ...(consoleTests.length > 0 && { tests: consoleTests }),
        })
      );

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

      {/* Request builder body — single column. The response panel is a
          resizable sibling supplied by the route (ResizableLayout), so this
          reads as request-left / response-right like HTTP / GraphQL. */}
      <div className="flex-1 flex flex-col gap-2.5 min-h-0 min-w-0">
        <GrpcMethodContext
          methodName={grpcRequest.method}
          methodType={grpcRequest.methodType}
          selectedMethod={reflection.selectedMethod}
          showSchema={reflection.showSchema}
          onToggleSchema={() => reflection.setShowSchema(!reflection.showSchema)}
        />

        <Floater
          radius="panel"
          elevation="float"
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
                    setTimeoutMs(Math.max(1000, parseInt(e.target.value, 10) || 30000))
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
            <GrpcProtoUploader
              protoFile={protoFile}
              onProtoFileChange={setProtoFile}
              onServiceChange={handleServiceChange}
              onMethodChange={handleMethodChange}
              onMethodTypeChange={handleMethodTypeChange}
            />
          </div>

          {reflectionResult && !reflectionResult.success && (
            <div className="mx-3 mt-2 p-2 rounded-sp-btn bg-red-500/10 text-destructive text-sp-11 font-mono flex items-start gap-1.5">
              <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span className="break-words">
                Reflection failed: {reflectionResult.error || 'Could not reach the gRPC server.'}
                {/certificate|self.?signed|unable to (get|verify)|\btls\b|\bssl\b/i.test(
                  reflectionResult.error ?? ''
                ) &&
                  ' — if the server uses a self-signed or private-CA certificate, add its CA in Settings → Certificates.'}
              </span>
            </div>
          )}

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
                  {...(activeTabId ? { editorPath: `tab-${activeTabId}-grpc-message` } : {})}
                />
              </div>
            )}

            {activeTab === 'metadata' && (
              <div className="p-3 space-y-3">
                <p className="text-sp-11 text-sp-muted font-mono">
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
                <InheritedAuthHint request={grpcRequest} />
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
                onPreRequestScriptChange={(script) => updateRequest({ preRequestScript: script })}
                onTestScriptChange={(script) => updateRequest({ testScript: script })}
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
                {...(resolvedProto?.content ? { protoContent: resolvedProto.content } : {})}
                {...(resolvedProto?.fileName ? { protoFileName: resolvedProto.fileName } : {})}
                {...(reflection.selectedService?.descriptors?.length
                  ? { descriptors: reflection.selectedService.descriptors }
                  : {})}
              />
            )}
          </div>
        </Floater>
      </div>
    </div>
  );
}

export default withErrorBoundary(GrpcRequestBuilder);
