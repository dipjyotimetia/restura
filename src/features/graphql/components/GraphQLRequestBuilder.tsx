import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useRequestStore } from '@/store/useRequestStore';
import { useHistoryStore } from '@/store/useHistoryStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { Send } from 'lucide-react';
import { toast } from 'sonner';
import { HttpRequest, Response } from '@/types';
import { useKeyValueCollection } from '@/hooks/useKeyValueCollection';
import { lazyComponent } from '@/lib/shared/lazyComponent';
import KeyValueEditor from '@/components/shared/KeyValueEditor';
import { withErrorBoundary } from '@/components/shared/ErrorBoundary';

const GraphQLBodyEditor = lazyComponent(() => import('./GraphQLBodyEditor'));

function GraphQLRequestBuilder() {
  const { currentRequest, updateRequest, setLoading, setCurrentResponse, isLoading } = useRequestStore();
  const { addHistoryItem } = useHistoryStore();
  const { resolveVariables } = useEnvironmentStore();
  const [activeTab, setActiveTab] = useState('query');
  const [graphqlVariables, setGraphqlVariables] = useState('{}');

  // Must be called before any early return — Rules of Hooks
  const {
    handleAdd: handleAddHeader,
    handleUpdate: handleUpdateHeader,
    handleDelete: handleDeleteHeader,
  } = useKeyValueCollection(
    (currentRequest as HttpRequest | null)?.headers ?? [],
    (headers) => updateRequest({ headers })
  );

  if (!currentRequest || currentRequest.type !== 'http') {
    return null;
  }

  const httpRequest = currentRequest as HttpRequest;

  const handleUrlChange = (url: string) => {
    updateRequest({ url });
  };

  const handleSendRequest = async () => {
    if (!httpRequest.url) {
      toast.error('URL required');
      return;
    }

    setLoading(true);
    const startTime = Date.now();

    try {
      const resolvedUrl = resolveVariables(httpRequest.url);

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      for (const header of httpRequest.headers) {
        if (header.enabled && header.key) {
          headers[resolveVariables(header.key)] = resolveVariables(header.value);
        }
      }

      let variables = {};
      try {
        variables = JSON.parse(graphqlVariables || '{}');
      } catch {
        toast.error('Invalid JSON in variables');
        setLoading(false);
        return;
      }

      const body = JSON.stringify({
        query: httpRequest.body.raw || '',
        variables,
      });

      const response = await fetch(resolvedUrl, {
        method: 'POST',
        headers,
        body,
      });

      const responseBody = await response.text();
      const endTime = Date.now();

      const responseData: Response = {
        id: `response-${Date.now()}`,
        requestId: httpRequest.id,
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        body: responseBody,
        size: new Blob([responseBody]).size,
        time: endTime - startTime,
        timestamp: Date.now(),
      };

      setCurrentResponse(responseData);
      addHistoryItem(httpRequest, responseData);

      if (response.ok) {
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

      const errorResponse: Response = {
        id: `response-${Date.now()}`,
        requestId: httpRequest.id,
        status: 0,
        statusText: 'Error',
        headers: {},
        body: errorMessage,
        size: 0,
        time: Date.now() - startTime,
        timestamp: Date.now(),
      };

      setCurrentResponse(errorResponse);
    } finally {
      setLoading(false);
    }
  };

  const activeHeaderCount = httpRequest.headers.filter((h) => h.enabled && h.key).length;

  return (
    <div className="flex-1 flex flex-col border-b border-border">
      {/* URL Zone */}
      <div className="flex items-center gap-1 px-3 h-12 border-y border-border bg-surface-2 shrink-0">
        <div className="flex items-center px-2 h-7 bg-primary/10 text-primary font-mono text-[10px] font-bold tracking-wider rounded shrink-0">
          POST
        </div>
        <span className="text-muted-foreground/40 font-mono text-sm select-none shrink-0">›</span>
        <Input
          value={httpRequest.url}
          onChange={(e) => handleUrlChange(e.target.value)}
          placeholder="Enter GraphQL endpoint URL"
          className="flex-1 h-7 bg-transparent border-0 font-mono text-sm px-2 focus-visible:ring-0 focus-visible:ring-offset-0"
          aria-label="GraphQL endpoint URL"
        />
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
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col overflow-hidden">
        <TabsList className="w-full justify-start border-b border-border rounded-none h-9 bg-transparent p-0 shrink-0">
          <TabsTrigger
            value="query"
            className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none h-9 px-4 font-mono text-xs"
          >
            Query
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
        </TabsList>

        <TabsContent value="query" className="flex-1 overflow-auto p-4 m-0">
          <GraphQLBodyEditor
            query={httpRequest.body.raw || ''}
            variables={graphqlVariables}
            url={httpRequest.url}
            onQueryChange={(query) => updateRequest({ body: { ...httpRequest.body, raw: query } })}
            onVariablesChange={setGraphqlVariables}
          />
        </TabsContent>

        <TabsContent value="headers" className="flex-1 overflow-auto p-4 m-0">
          <p className="text-xs text-muted-foreground font-mono mb-3">
            Content-Type: application/json is automatically set for GraphQL requests.
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
      </Tabs>
    </div>
  );
}

export default withErrorBoundary(GraphQLRequestBuilder);
