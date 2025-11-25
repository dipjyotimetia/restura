'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useRequestStore } from '@/store/useRequestStore';
import { useHistoryStore } from '@/store/useHistoryStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { Send, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { HttpRequest, Response } from '@/types';
import { useKeyValueCollection } from '@/hooks/useKeyValueCollection';
import { lazy } from 'react';

const GraphQLBodyEditor = lazy(() => import('./GraphQLBodyEditor'));

export default function GraphQLRequestBuilder() {
  const { currentRequest, updateRequest, setLoading, setCurrentResponse, isLoading } = useRequestStore();
  const { addHistoryItem } = useHistoryStore();
  const { resolveVariables } = useEnvironmentStore();
  const [activeTab, setActiveTab] = useState('query');
  const [graphqlVariables, setGraphqlVariables] = useState('{}');

  // Create a default HTTP request if none exists or it's not HTTP type
  if (!currentRequest || currentRequest.type !== 'http') {
    return null;
  }

  const httpRequest = currentRequest as HttpRequest;

  // Use shared hook for headers management
  const {
    handleAdd: handleAddHeader,
    handleUpdate: handleUpdateHeader,
    handleDelete: handleDeleteHeader,
  } = useKeyValueCollection(httpRequest.headers, (headers) => updateRequest({ headers }));

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

      // Build headers
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      for (const header of httpRequest.headers) {
        if (header.enabled && header.key) {
          headers[resolveVariables(header.key)] = resolveVariables(header.value);
        }
      }

      // Parse variables
      let variables = {};
      try {
        variables = JSON.parse(graphqlVariables || '{}');
      } catch {
        toast.error('Invalid JSON in variables');
        setLoading(false);
        return;
      }

      // Build GraphQL body
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

  return (
    <div className="flex-1 flex flex-col border-b border-border">
      {/* URL Bar */}
      <div className="p-4 border-b border-border">
        <div className="flex gap-2">
          <div className="flex items-center px-3 bg-purple-500/10 text-purple-500 font-medium text-sm rounded-l border border-r-0 border-border">
            POST
          </div>
          <Input
            value={httpRequest.url}
            onChange={(e) => handleUrlChange(e.target.value)}
            placeholder="Enter GraphQL endpoint URL"
            className="flex-1 bg-background border-border rounded-l-none"
          />
          <Button
            onClick={handleSendRequest}
            disabled={isLoading || !httpRequest.url}
            aria-label={isLoading ? 'Sending GraphQL query' : 'Send GraphQL query'}
          >
            <Send className="mr-2 h-4 w-4" />
            {isLoading ? 'Sending...' : 'Send'}
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col">
        <div className="px-4 py-2 border-b bg-muted/20">
          <TabsList className="h-9 w-full justify-start bg-muted/50 p-1 text-muted-foreground">
            <TabsTrigger
              value="query"
              className="data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
            >
              Query
            </TabsTrigger>
            <TabsTrigger
              value="headers"
              className="data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm"
            >
              Headers
              <span className="ml-1 text-xs text-muted-foreground">
                ({httpRequest.headers.filter((h) => h.enabled).length})
              </span>
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="query" className="flex-1 overflow-auto p-4 m-0">
          <GraphQLBodyEditor
            query={httpRequest.body.raw || ''}
            variables={graphqlVariables}
            url={httpRequest.url}
            onQueryChange={(query: string) => updateRequest({ body: { ...httpRequest.body, raw: query } })}
            onVariablesChange={setGraphqlVariables}
          />
        </TabsContent>

        <TabsContent value="headers" className="flex-1 overflow-auto p-4 m-0">
          <div className="space-y-2">
            <div className="text-sm text-muted-foreground mb-2">
              Content-Type: application/json is automatically set for GraphQL requests.
            </div>
            {httpRequest.headers.map((header) => (
              <div key={header.id} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={header.enabled}
                  onChange={(e) => handleUpdateHeader(header.id, { enabled: e.target.checked })}
                  className="h-4 w-4"
                />
                <Input
                  value={header.key}
                  onChange={(e) => handleUpdateHeader(header.id, { key: e.target.value })}
                  placeholder="Header name"
                  className="flex-1"
                />
                <Input
                  value={header.value}
                  onChange={(e) => handleUpdateHeader(header.id, { value: e.target.value })}
                  placeholder="Value"
                  className="flex-1"
                />
                <Button variant="ghost" size="icon" onClick={() => handleDeleteHeader(header.id)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
            <Button onClick={handleAddHeader} variant="outline" size="sm">
              <Plus className="mr-2 h-4 w-4" />
              Add Header
            </Button>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
