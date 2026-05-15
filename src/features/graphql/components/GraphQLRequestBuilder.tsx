import { useState, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useRequestStore } from '@/store/useRequestStore';
import { useActiveRequest } from '@/store/selectors';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { Send, Plug, PlugZap, CheckCircle } from 'lucide-react';
import { toast } from 'sonner';
import type { HttpRequest } from '@/types';
import { useKeyValueCollection } from '@/hooks/useKeyValueCollection';
import { lazyComponent } from '@/lib/shared/lazyComponent';
import KeyValueEditor from '@/components/shared/KeyValueEditor';
import { withErrorBoundary } from '@/components/shared/ErrorBoundary';
import { extractOperationType } from '@/features/graphql/lib/queryParser';
import { GraphQLSubscriptionClient, type SubscriptionMessage } from '@/features/graphql/lib/subscriptionClient';
import AuthConfiguration from '@/features/auth/components/AuthConfig';
import type { AuthConfig as AuthConfigType } from '@/types';
import ScriptsEditor from '@/features/scripts/components/ScriptsEditor';
import { useRequestRunner } from '@/features/registry/useRequestRunner';

const GraphQLBodyEditor = lazyComponent(() => import('./GraphQLBodyEditor'));

function GraphQLRequestBuilder() {
  // GraphQL is HTTP under the hood — narrow the active tab to an HttpRequest.
  const currentRequest = useActiveRequest('http');
  const updateRequest = useRequestStore((s) => s.updateRequest);
  const setLoading = useRequestStore((s) => s.setLoading);
  const setCurrentResponse = useRequestStore((s) => s.setCurrentResponse);
  const setScriptResult = useRequestStore((s) => s.setScriptResult);
  const isLoading = useRequestStore((s) => s.isLoading);
  const { resolveVariables } = useEnvironmentStore();
  const { run: runViaRegistry } = useRequestRunner();
  const [activeTab, setActiveTab] = useState('query');
  const [graphqlVariables, setGraphqlVariables] = useState('{}');
  const [subscriptionMessages, setSubscriptionMessages] = useState<SubscriptionMessage[]>([]);
  const [isSubscribed, setIsSubscribed] = useState(false);
  const subscriptionClientRef = useRef<GraphQLSubscriptionClient | null>(null);

  // Must be called before any early return — Rules of Hooks
  const {
    handleAdd: handleAddHeader,
    handleUpdate: handleUpdateHeader,
    handleDelete: handleDeleteHeader,
  } = useKeyValueCollection(
    currentRequest?.headers ?? [],
    (headers) => updateRequest({ headers })
  );

  if (!currentRequest) {
    return null;
  }

  const httpRequest: HttpRequest = currentRequest;
  const query = httpRequest.body.raw || '';
  const operationType = extractOperationType(query);
  const isSubscription = operationType === 'subscription';

  const buildHeaders = (): Record<string, string> => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    for (const header of httpRequest.headers) {
      if (header.enabled && header.key) {
        headers[resolveVariables(header.key)] = resolveVariables(header.value);
      }
    }
    // Inject auth header
    const auth = httpRequest.auth;
    if (auth.type === 'bearer' && auth.bearer?.token) {
      headers['Authorization'] = `Bearer ${auth.bearer.token}`;
    } else if (auth.type === 'basic' && auth.basic?.username) {
      headers['Authorization'] = `Basic ${btoa(`${auth.basic.username}:${auth.basic.password}`)}`;
    } else if (auth.type === 'api-key' && auth.apiKey?.key && auth.apiKey?.value) {
      if (auth.apiKey.in === 'header') {
        headers[auth.apiKey.key] = auth.apiKey.value;
      }
    } else if (auth.type === 'oauth2' && auth.oauth2?.accessToken) {
      headers['Authorization'] = `${auth.oauth2.tokenType || 'Bearer'} ${auth.oauth2.accessToken}`;
    }
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

    // Build the wire-shaped request: GraphQL POSTs `{ query, variables }`
    // as JSON, with auth headers folded into the request's header list so
    // the runner's HTTP executor handles them uniformly. We don't mutate
    // the stored request — the user's editor still shows the bare query.
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

  const activeHeaderCount = httpRequest.headers.filter((h) => h.enabled && h.key).length;

  const renderSendButton = () => {
    if (isSubscription) {
      if (isSubscribed) {
        return (
          <Button
            variant="destructive"
            size="sm"
            onClick={handleUnsubscribe}
            className="h-7 min-w-[100px] shrink-0"
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
          className="h-7 min-w-[100px] shrink-0"
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
        className="h-7 min-w-[72px] shrink-0"
      >
        <Send className="mr-1.5 h-3.5 w-3.5" />
        {isLoading ? 'Sending...' : 'Send'}
      </Button>
    );
  };

  return (
    <div className="flex-1 flex flex-col border-b border-border">
      {/* URL Zone */}
      <div className="flex items-center gap-1 px-3 h-12 border-y border-border bg-surface-2 shrink-0">
        <div className="flex items-center px-2 h-7 bg-primary/10 text-primary font-mono text-[10px] font-bold tracking-wider rounded shrink-0">
          {isSubscription ? 'SUB' : 'POST'}
        </div>
        <span className="text-muted-foreground/40 font-mono text-sm select-none shrink-0">›</span>
        <Input
          value={httpRequest.url}
          onChange={(e) => updateRequest({ url: e.target.value })}
          placeholder="https://echo.restura.dev/graphql"
          className="flex-1 h-7 bg-transparent border-0 font-mono text-sm px-2 focus-visible:ring-0 focus-visible:ring-offset-0"
          aria-label="GraphQL endpoint URL"
        />
        {renderSendButton()}
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col overflow-hidden">
        <TabsList className="w-full justify-start border-b border-border rounded-none h-9 bg-transparent p-0 shrink-0">
          <TabsTrigger
            value="query"
            className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none h-9 px-4 font-mono text-xs"
          >
            Query
            {operationType && (
              <span className="ml-1 text-[10px] text-muted-foreground">({operationType})</span>
            )}
          </TabsTrigger>
          <TabsTrigger
            value="headers"
            className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none h-9 px-4 font-mono text-xs"
          >
            Headers
            {activeHeaderCount > 0 && (
              <span className="ml-1 text-[10px] text-muted-foreground">({activeHeaderCount})</span>
            )}
          </TabsTrigger>
          <TabsTrigger
            value="auth"
            className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none h-9 px-4 font-mono text-xs"
          >
            Auth
            {httpRequest.auth.type !== 'none' && (
              <CheckCircle className="ml-1 h-3 w-3 text-emerald-400" />
            )}
          </TabsTrigger>
          <TabsTrigger
            value="scripts"
            className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none h-9 px-4 font-mono text-xs"
          >
            Scripts
            {(httpRequest.preRequestScript?.trim() || httpRequest.testScript?.trim()) && (
              <CheckCircle className="ml-1 h-3 w-3 text-emerald-400" />
            )}
          </TabsTrigger>
          {isSubscription && (
            <TabsTrigger
              value="subscription"
              className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none h-9 px-4 font-mono text-xs"
            >
              Messages
              {subscriptionMessages.filter((m) => m.type === 'data').length > 0 && (
                <span className="ml-1 text-[10px] text-muted-foreground">
                  ({subscriptionMessages.filter((m) => m.type === 'data').length})
                </span>
              )}
              {isSubscribed && (
                <span className="ml-1 h-2 w-2 rounded-full bg-emerald-400 animate-pulse inline-block" />
              )}
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="query" className="flex-1 overflow-auto p-4 m-0">
          <GraphQLBodyEditor
            query={query}
            variables={graphqlVariables}
            url={httpRequest.url}
            onQueryChange={(q) => updateRequest({ body: { ...httpRequest.body, raw: q } })}
            onVariablesChange={setGraphqlVariables}
          />
        </TabsContent>

        <TabsContent value="headers" className="flex-1 overflow-auto p-4 m-0">
          <p className="text-xs text-muted-foreground font-mono mb-3">
            Content-Type: application/json is automatically set. Auth header is injected from the Auth tab.
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
        </TabsContent>

        <TabsContent value="auth" className="flex-1 overflow-auto p-4 m-0">
          <p className="text-xs text-muted-foreground font-mono mb-4">
            For subscriptions, credentials are sent as WebSocket connection params.
          </p>
          <AuthConfiguration auth={httpRequest.auth} onChange={handleAuthChange} />
        </TabsContent>

        <TabsContent value="scripts" className="flex-1 overflow-auto m-0">
          <ScriptsEditor
            preRequestScript={httpRequest.preRequestScript || ''}
            testScript={httpRequest.testScript || ''}
            onPreRequestScriptChange={(script) => updateRequest({ preRequestScript: script })}
            onTestScriptChange={(script) => updateRequest({ testScript: script })}
          />
        </TabsContent>

        {isSubscription && (
          <TabsContent value="subscription" className="flex-1 overflow-auto p-4 m-0">
            {subscriptionMessages.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground font-mono text-sm">
                {isSubscribed ? 'Waiting for messages...' : 'Click Subscribe to start receiving events.'}
              </div>
            ) : (
              <div className="space-y-2">
                {subscriptionMessages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`p-2 rounded border text-xs font-mono ${
                      msg.type === 'data'
                        ? 'bg-emerald-500/5 border-emerald-500/20'
                        : msg.type === 'error'
                          ? 'bg-destructive/5 border-destructive/20'
                          : msg.type === 'connected'
                            ? 'bg-blue-500/5 border-blue-500/20'
                            : 'bg-surface-2 border-border'
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-1 text-[10px] text-muted-foreground uppercase tracking-widest">
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
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}

export default withErrorBoundary(GraphQLRequestBuilder);
