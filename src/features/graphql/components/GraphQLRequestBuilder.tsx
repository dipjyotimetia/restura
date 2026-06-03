'use client';

import { useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useRequestStore } from '@/store/useRequestStore';
import { useActiveRequest, useActiveTab } from '@/store/selectors';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useGraphQLSchemaStore } from '@/store/useGraphQLSchemaStore';
import { CheckCircle, Download, PanelLeft, Plug, PlugZap, Send, Wand2 } from 'lucide-react';
import { toast } from 'sonner';
import type { HttpRequest, AuthConfig as AuthConfigType } from '@/types';
import { useKeyValueCollection } from '@/hooks/useKeyValueCollection';
import { lazyComponent } from '@/lib/shared/lazyComponent';
import KeyValueEditor from '@/components/shared/KeyValueEditor';
import { CodeEditorSkeleton } from '@/components/shared/CodeEditorSkeleton';
import { withErrorBoundary } from '@/components/shared/ErrorBoundary';
import { extractOperationType } from '@/features/graphql/lib/queryParser';
import {
  GraphQLSubscriptionClient,
  type SubscriptionMessage,
} from '@/features/graphql/lib/subscriptionClient';
import AuthConfiguration from '@/features/auth/components/AuthConfig';
import { buildAuthCredential } from '@/features/auth/lib/buildAuthCredential';
import ScriptsEditor from '@/features/scripts/components/ScriptsEditor';
import { useRequestRunner } from '@/features/registry/useRequestRunner';
import { ECHO_URLS } from '@/lib/shared/echo-defaults';
import { Floater, SubTabBar, type SubTab } from '@/components/ui/spatial';
import { cn } from '@/lib/shared/utils';
import { formatQuery } from '@/features/graphql/lib/formatter';
import {
  buildSchemaFromIntrospection,
  exportSchemaToSDL,
} from '@/features/graphql/lib/introspection';
import SchemaExplorer from './SchemaExplorer';

const GraphQLBodyEditor = lazyComponent(() => import('./GraphQLBodyEditor'));
const CodeEditor = lazyComponent(
  () => import('@/components/shared/CodeEditor'),
  <CodeEditorSkeleton className="h-[260px]" />
);

type TabValue = 'query' | 'variables' | 'headers' | 'auth' | 'scripts' | 'subscription';

function GraphQLRequestBuilder() {
  // GraphQL is HTTP under the hood — narrow the active tab to an HttpRequest.
  const currentRequest = useActiveRequest('http');
  const activeTabId = useActiveTab()?.id;
  const updateRequest = useRequestStore((s) => s.updateRequest);
  const setLoading = useRequestStore((s) => s.setLoading);
  const setCurrentResponse = useRequestStore((s) => s.setCurrentResponse);
  const setScriptResult = useRequestStore((s) => s.setScriptResult);
  const isLoading = useRequestStore((s) => s.isLoading);
  const { resolveVariables } = useEnvironmentStore();
  const { fetchSchema, getSchema, isLoading: isSchemaLoading } = useGraphQLSchemaStore();
  const { run: runViaRegistry } = useRequestRunner();
  const [activeTab, setActiveTab] = useState<TabValue>('query');
  // Schema explorer is hidden by default so the query editor gets the full
  // builder width (side-by-side leaves the pane narrow); the URL-bar toggle
  // reveals it on demand, matching the gRPC/MCP catalog pattern.
  const [showSchema, setShowSchema] = useState(false);
  const [graphqlVariables, setGraphqlVariables] = useState('{}');
  const [subscriptionMessages, setSubscriptionMessages] = useState<SubscriptionMessage[]>([]);
  const [isSubscribed, setIsSubscribed] = useState(false);
  const subscriptionClientRef = useRef<GraphQLSubscriptionClient | null>(null);

  const {
    handleAdd: handleAddHeader,
    handleUpdate: handleUpdateHeader,
    handleDelete: handleDeleteHeader,
  } = useKeyValueCollection(currentRequest?.headers ?? [], (headers) => updateRequest({ headers }));

  const url = currentRequest?.url ?? '';
  const schemaResult = url ? getSchema(url) : null;
  const schemaLoading = url ? isSchemaLoading(url) : false;
  const executableSchema = useMemo(
    () => (schemaResult ? buildSchemaFromIntrospection(schemaResult) : null),
    [schemaResult]
  );

  if (!currentRequest) {
    return null;
  }

  const httpRequest: HttpRequest = currentRequest;
  const query = httpRequest.body.raw || '';
  const operationType = extractOperationType(query);
  const isSubscription = operationType === 'subscription';

  const activeHeaderCount = httpRequest.headers.filter((h) => h.enabled && h.key).length;
  const detectedVarCount = (() => {
    try {
      const parsed = JSON.parse(graphqlVariables || '{}');
      return parsed && typeof parsed === 'object' ? Object.keys(parsed).length : 0;
    } catch {
      return 0;
    }
  })();
  const queryBytes = new Blob([query]).size;

  const buildHeaders = (): Record<string, string> => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    for (const header of httpRequest.headers) {
      if (header.enabled && header.key) {
        headers[resolveVariables(header.key)] = resolveVariables(header.value);
      }
    }
    const credential = buildAuthCredential(httpRequest.auth);
    Object.assign(headers, credential.headers);
    return headers;
  };

  const handleSubscribe = () => {
    const resolvedUrl = resolveVariables(httpRequest.url);
    if (!resolvedUrl) {
      toast.error('URL required');
      return;
    }

    let variables: Record<string, unknown> = {};
    try {
      variables = JSON.parse(graphqlVariables || '{}');
    } catch {
      toast.error('Invalid JSON in variables');
      return;
    }

    setSubscriptionMessages([]);
    setIsSubscribed(true);

    const headers = buildHeaders();
    const client = new GraphQLSubscriptionClient(resolvedUrl, headers);
    subscriptionClientRef.current = client;

    client.connect({
      url: resolvedUrl,
      query,
      variables,
      headers,
      onMessage: (msg) => {
        setSubscriptionMessages((prev) => [...prev, msg]);
        if (msg.type === 'complete') {
          setIsSubscribed(false);
          subscriptionClientRef.current = null;
        }
      },
      onError: () => {
        setIsSubscribed(false);
        subscriptionClientRef.current = null;
        toast.error('Subscription error');
      },
    });

    setActiveTab('subscription');
  };

  const handleUnsubscribe = () => {
    subscriptionClientRef.current?.disconnect();
    subscriptionClientRef.current = null;
    setIsSubscribed(false);
    toast.info('Subscription cancelled');
  };

  const handleSendRequest = async () => {
    if (!httpRequest.url) {
      toast.error('URL required');
      return;
    }

    let parsedVariables: Record<string, unknown>;
    try {
      parsedVariables = JSON.parse(graphqlVariables || '{}');
    } catch {
      toast.error('Invalid JSON in variables');
      return;
    }

    setLoading(true);
    setScriptResult(null);

    const wireBody = JSON.stringify({
      query: httpRequest.body.raw || '',
      variables: parsedVariables,
    });
    const wireHeaders = httpRequest.headers.slice();
    const hasContentType = wireHeaders.some(
      (h) => h.enabled && h.key.toLowerCase() === 'content-type'
    );
    if (!hasContentType) {
      wireHeaders.push({
        id: 'graphql-content-type',
        key: 'Content-Type',
        value: 'application/json',
        enabled: true,
      });
    }
    const wireRequest: HttpRequest = {
      ...httpRequest,
      method: 'POST',
      headers: wireHeaders,
      body: { ...httpRequest.body, type: 'json', raw: wireBody },
    };

    try {
      const { response } = await runViaRegistry(wireRequest, 'graphql');
      setCurrentResponse(response);

      if (response.status >= 200 && response.status < 300) {
        toast.success('Request completed', {
          description: `${response.status} ${response.statusText}`,
        });
      } else {
        toast.error(`Request failed: ${response.status}`, {
          description: response.statusText,
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Request failed';
      toast.error('Request failed', { description: errorMessage });
    } finally {
      setLoading(false);
    }
  };

  const handleAuthChange = (auth: AuthConfigType) => {
    updateRequest({ auth });
  };

  const handlePrettify = () => {
    if (!query.trim()) return;
    const formatted = formatQuery(query);
    updateRequest({ body: { ...httpRequest.body, raw: formatted } });
  };

  const handleDownloadSDL = () => {
    if (!executableSchema) {
      toast.error('No schema loaded');
      return;
    }
    const sdl = exportSchemaToSDL(executableSchema);
    const blob = new Blob([sdl], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'schema.graphql';
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const handleFieldSelect = (field: string) => {
    updateRequest({
      body: { ...httpRequest.body, raw: `${query}\n  ${field}` },
    });
    setActiveTab('query');
  };

  const handleRefreshSchema = () => {
    if (!url) {
      toast.error('Set a URL first');
      return;
    }
    void fetchSchema(url);
  };

  const renderSendButton = () => {
    if (isSubscription) {
      if (isSubscribed) {
        return (
          <Button
            variant="destructive"
            size="sm"
            onClick={handleUnsubscribe}
            className="h-7 min-w-[100px] shrink-0 text-xs font-medium"
          >
            <PlugZap className="mr-1.5 h-3.5 w-3.5" />
            Unsubscribe
          </Button>
        );
      }
      return (
        <Button
          variant="glow"
          size="sm"
          onClick={handleSubscribe}
          disabled={!httpRequest.url}
          className="h-7 min-w-[100px] shrink-0 text-xs font-medium"
        >
          <Plug className="mr-1.5 h-3.5 w-3.5" />
          Subscribe
        </Button>
      );
    }
    return (
      <Button
        variant="glow"
        size="sm"
        onClick={handleSendRequest}
        disabled={isLoading || !httpRequest.url}
        aria-label={isLoading ? 'Sending GraphQL query' : 'Send GraphQL query'}
        className="h-7 min-w-[72px] shrink-0 text-xs font-medium"
      >
        <Send className="mr-1.5 h-3.5 w-3.5" />
        {isLoading ? 'Sending...' : 'Send'}
      </Button>
    );
  };

  const tabs: SubTab<TabValue>[] = [
    { value: 'query', label: 'Query', ...(operationType ? { badge: operationType } : {}) },
    { value: 'variables', label: 'Variables', count: detectedVarCount },
    { value: 'headers', label: 'Headers', count: activeHeaderCount },
    { value: 'auth', label: 'Auth' },
    { value: 'scripts', label: 'Scripts' },
    ...(isSubscription
      ? ([
          {
            value: 'subscription',
            label: 'Messages',
            count: subscriptionMessages.filter((m) => m.type === 'data').length,
          },
        ] as SubTab<TabValue>[])
      : []),
  ];

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
      {/* URL zone */}
      <div className="flex items-center gap-1 px-3 h-12 border-y border-sp-line bg-sp-surface-lo backdrop-blur-md shrink-0">
        <div
          className={cn(
            'flex items-center justify-center px-2 h-7 w-20 font-mono text-[11px] font-bold tracking-wider rounded shrink-0 border',
            isSubscription
              ? 'bg-violet-500/[0.12] border-violet-500/25 text-violet-400'
              : 'bg-amber-500/[0.12] border-amber-500/25 text-amber-400'
          )}
          aria-label={isSubscription ? 'GraphQL subscription' : 'GraphQL query (POST)'}
        >
          {isSubscription ? 'SUB' : 'POST'}
        </div>
        <span className="text-sp-dim font-mono text-sm select-none shrink-0">›</span>
        <Input
          value={httpRequest.url}
          onChange={(e) => updateRequest({ url: e.target.value })}
          placeholder={ECHO_URLS.graphql}
          className="flex-1 h-7 bg-transparent border-0 font-mono text-sm px-2 focus-visible:outline-none focus-visible:ring-0 focus-visible:shadow-none placeholder:text-sp-dim"
          aria-label="GraphQL endpoint URL"
        />
        <button
          type="button"
          onClick={() => setShowSchema((s) => !s)}
          aria-pressed={showSchema}
          title={showSchema ? 'Hide schema' : 'Browse schema'}
          className={cn(
            'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-sp-btn text-sp-12 font-medium shrink-0 transition-colors',
            showSchema
              ? 'bg-sp-active text-sp-text'
              : 'text-sp-muted hover:text-sp-text hover:bg-sp-hover'
          )}
        >
          <PanelLeft className="h-3.5 w-3.5" />
          Schema
        </button>
        {renderSendButton()}
      </div>

      {/* Body: schema (toggleable) + editor */}
      <div className="flex-1 flex gap-2.5 p-3 min-h-0 overflow-hidden">
        {showSchema && (
          <SchemaExplorer
            schema={schemaResult?.schema ?? null}
            onFieldSelect={handleFieldSelect}
            onRefresh={handleRefreshSchema}
            loading={schemaLoading}
            loaded={Boolean(schemaResult?.success)}
          />
        )}

        {/* Editor pane */}
        <Floater
          radius="panel"
          elevation="float"
          className="flex-1 flex flex-col min-w-0 overflow-hidden"
          style={{ background: 'var(--sp-code)' }}
        >
          <SubTabBar<TabValue>
            tabs={tabs}
            value={activeTab}
            onChange={setActiveTab}
            right={
              activeTab === 'query' ? (
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handlePrettify}
                    disabled={!query.trim()}
                    className="inline-flex items-center gap-1 h-6 px-2 rounded-sp-chip text-sp-11 font-medium text-sp-muted hover:text-sp-text hover:bg-sp-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Wand2 className="h-3 w-3" />
                    Prettify
                  </button>
                  <button
                    type="button"
                    onClick={handleDownloadSDL}
                    disabled={!executableSchema}
                    className="inline-flex items-center gap-1 h-6 px-2 rounded-sp-chip text-sp-11 font-medium text-sp-muted hover:text-sp-text hover:bg-sp-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Download className="h-3 w-3" />
                    SDL
                  </button>
                  <span className="font-mono text-sp-10 text-sp-dim tabular-nums">
                    {queryBytes} B
                  </span>
                </div>
              ) : activeTab === 'auth' && httpRequest.auth.type !== 'none' ? (
                <CheckCircle className="h-3 w-3 text-emerald-400" />
              ) : activeTab === 'scripts' &&
                (httpRequest.preRequestScript?.trim() || httpRequest.testScript?.trim()) ? (
                <CheckCircle className="h-3 w-3 text-emerald-400" />
              ) : null
            }
          />

          {/* Tab content */}
          <div className="flex-1 min-h-0 overflow-hidden">
            {activeTab === 'query' && (
              <GraphQLBodyEditor
                query={query}
                variables={graphqlVariables}
                url={httpRequest.url}
                onQueryChange={(q) => updateRequest({ body: { ...httpRequest.body, raw: q } })}
                onVariablesChange={setGraphqlVariables}
              />
            )}

            {activeTab === 'variables' && (
              <div className="p-3 h-full">
                <div
                  className="rounded-sp-panel border border-sp-line overflow-hidden h-full"
                  style={{ background: 'var(--sp-code)' }}
                >
                  <CodeEditor
                    value={graphqlVariables || '{}'}
                    onChange={setGraphqlVariables}
                    language="json"
                    height="100%"
                    {...(activeTabId ? { path: `tab-${activeTabId}-graphql-variables-full` } : {})}
                  />
                </div>
              </div>
            )}

            {activeTab === 'headers' && (
              <div className="p-3 overflow-auto h-full">
                <p className="text-sp-11 text-sp-muted font-mono mb-3">
                  Content-Type: application/json is automatically set. Auth header is injected from
                  the Auth tab.
                </p>
                <KeyValueEditor
                  items={httpRequest.headers}
                  onAdd={handleAddHeader}
                  onUpdate={handleUpdateHeader}
                  onDelete={handleDeleteHeader}
                  keyPlaceholder="Header name"
                  valuePlaceholder="Value"
                  addButtonText="Add Header"
                  itemType="header"
                />
              </div>
            )}

            {activeTab === 'auth' && (
              <div className="p-3 overflow-auto h-full">
                <p className="text-sp-11 text-sp-muted font-mono mb-4">
                  For subscriptions, credentials are sent as WebSocket connection params.
                </p>
                <AuthConfiguration auth={httpRequest.auth} onChange={handleAuthChange} />
              </div>
            )}

            {activeTab === 'scripts' && (
              <div className="overflow-auto h-full">
                <ScriptsEditor
                  preRequestScript={httpRequest.preRequestScript || ''}
                  testScript={httpRequest.testScript || ''}
                  onPreRequestScriptChange={(script) => updateRequest({ preRequestScript: script })}
                  onTestScriptChange={(script) => updateRequest({ testScript: script })}
                />
              </div>
            )}

            {activeTab === 'subscription' && isSubscription && (
              <div className="p-3 overflow-auto h-full">
                {subscriptionMessages.length === 0 ? (
                  <div className="text-center py-8 text-sp-muted font-mono text-sp-12">
                    {isSubscribed
                      ? 'Waiting for messages...'
                      : 'Click Subscribe to start receiving events.'}
                  </div>
                ) : (
                  <div className="space-y-2">
                    {subscriptionMessages.map((msg) => (
                      <div
                        key={msg.id}
                        className={cn(
                          'p-2 rounded-sp-btn border text-sp-11 font-mono',
                          msg.type === 'data'
                            ? 'bg-emerald-500/5 border-emerald-500/20'
                            : msg.type === 'error'
                              ? 'bg-destructive/5 border-destructive/20'
                              : msg.type === 'connected'
                                ? 'bg-blue-500/5 border-blue-500/20'
                                : 'bg-sp-surface-lo border-sp-line'
                        )}
                      >
                        <div className="flex items-center gap-2 mb-1 sp-label">
                          <span>{msg.type}</span>
                          <span>{new Date(msg.timestamp).toLocaleTimeString()}</span>
                        </div>
                        {msg.payload !== undefined && (
                          <pre className="whitespace-pre-wrap break-all">
                            {JSON.stringify(msg.payload, null, 2)}
                          </pre>
                        )}
                        {msg.error && <span className="text-destructive">{msg.error}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </Floater>
      </div>
    </div>
  );
}

export default withErrorBoundary(GraphQLRequestBuilder);
