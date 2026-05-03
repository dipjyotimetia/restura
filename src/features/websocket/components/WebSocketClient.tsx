import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import {
  useWebSocketStore,
  WebSocketMessageType,
} from '@/store/useWebSocketStore';
import { websocketManager } from '@/features/websocket/lib/websocketManager';
import {
  Send,
  Trash2,
  Plus,
  Search,
  RefreshCw,
  Binary,
  Download,
  AlertTriangle,
} from 'lucide-react';
import { KeyValue } from '@/types';
import { withErrorBoundary } from '@/components/shared/ErrorBoundary';
import { cn } from '@/lib/shared/utils';

const formatDuration = (ms: number): string => {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
};

function WebSocketClient() {
  const [message, setMessage] = useState('');
  const [activeTab, setActiveTab] = useState('messages');
  const [sendAsBinary, setSendAsBinary] = useState(false);

  const { resolveVariables } = useEnvironmentStore();

  const {
    activeConnectionId,
    connections,
    messageFilter,
    searchQuery,
    createConnection,
    updateConnectionUrl,
    setAutoReconnect,
    clearMessages,
    addHeader,
    updateHeader,
    removeHeader,
    setMessageFilter,
    setSearchQuery,
    getFilteredMessages,
    addMessage,
    setProtocols,
  } = useWebSocketStore();

  const connection = activeConnectionId ? connections[activeConnectionId] : null;

  // Track current connection ID in a ref so the unmount cleanup always disconnects the right one
  const activeConnectionIdRef = useRef(activeConnectionId);
  useEffect(() => { activeConnectionIdRef.current = activeConnectionId; }, [activeConnectionId]);

  useEffect(() => {
    if (!activeConnectionId) {
      createConnection();
    }
  }, [activeConnectionId, createConnection]);

  // Disconnect only on unmount, not on every activeConnectionId change
  useEffect(() => {
    return () => {
      if (activeConnectionIdRef.current) {
        websocketManager.disconnect(activeConnectionIdRef.current);
      }
    };
  }, []);

  // Tick every second while connected so the duration display stays live.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (connection?.status !== 'connected') return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [connection?.status]);

  if (!connection || !activeConnectionId) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Button onClick={() => createConnection()}>Create Connection</Button>
      </div>
    );
  }

  const isConnected = connection.status === 'connected';
  const isConnecting = connection.status === 'connecting' || connection.status === 'reconnecting';

  const handleConnect = () => {
    try {
      const resolvedUrl = resolveVariables(connection.url);
      websocketManager.connect(
        activeConnectionId,
        resolvedUrl,
        connection.protocols.length > 0 ? connection.protocols : undefined
      );
    } catch (error) {
      console.error('Failed to connect:', error);
    }
  };

  const handleDisconnect = () => {
    websocketManager.disconnect(activeConnectionId);
  };

  const handleSendMessage = () => {
    if (!message.trim()) return;

    if (sendAsBinary) {
      try {
        const buffer = websocketManager.hexToArrayBuffer(message);
        websocketManager.send(activeConnectionId, buffer);
        setMessage('');
      } catch {
        addMessage(
          activeConnectionId,
          'system',
          `Invalid hex format: "${message.substring(0, 50)}${message.length > 50 ? '...' : ''}". Expected space-separated hex bytes (e.g., "48 65 6c 6c 6f")`
        );
      }
    } else {
      websocketManager.send(activeConnectionId, message);
      setMessage('');
    }
  };

  const handleClearMessages = () => {
    clearMessages(activeConnectionId);
  };

  const handleAddHeader = () => {
    addHeader(activeConnectionId);
  };

  const handleUpdateHeader = (id: string, updates: Partial<KeyValue>) => {
    updateHeader(activeConnectionId, id, updates);
  };

  const handleDeleteHeader = (id: string) => {
    removeHeader(activeConnectionId, id);
  };

  const handleExportMessages = () => {
    const messages = connection.messages.map((msg) => ({
      timestamp: new Date(msg.timestamp).toISOString(),
      type: msg.type,
      dataType: msg.dataType,
      content: msg.content,
    }));

    const exportData = {
      url: connection.url,
      protocols: connection.protocols,
      exportedAt: new Date().toISOString(),
      messageCount: messages.length,
      messages,
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `websocket-messages-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const connectionDuration =
    isConnected && connection.lastConnectedAt ? now - connection.lastConnectedAt : 0;

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      fractionalSecondDigits: 3,
    });
  };

  const getMessageRowClass = (type: WebSocketMessageType) => {
    switch (type) {
      case 'sent':
        return 'bg-primary/5 border-l-2 border-primary/30';
      case 'received':
        return 'bg-surface-2';
      case 'system':
        return 'bg-amber-500/5 border-l-2 border-amber-500/30';
    }
  };

  const getMessageLabelClass = (type: WebSocketMessageType) => {
    switch (type) {
      case 'sent':
        return 'text-primary';
      case 'received':
        return 'text-emerald-400';
      case 'system':
        return 'text-amber-400';
    }
  };

  const getMessageLabel = (type: WebSocketMessageType) => {
    switch (type) {
      case 'sent': return 'SENT';
      case 'received': return 'RECV';
      case 'system': return 'SYS';
    }
  };

  const getStatusDotClass = () => {
    switch (connection.status) {
      case 'connected':
        return 'bg-emerald-400 shadow-[0_0_6px_theme(colors.emerald.400)]';
      case 'connecting':
      case 'reconnecting':
        return 'bg-amber-400 shadow-[0_0_6px_theme(colors.amber.400)]';
      default:
        return 'bg-muted-foreground';
    }
  };

  const getStatusText = () => {
    switch (connection.status) {
      case 'connected': return 'Connected';
      case 'connecting': return 'Connecting...';
      case 'reconnecting':
        return `Reconnecting (${connection.reconnectAttempts}/${connection.maxReconnectAttempts})`;
      default: return 'Disconnected';
    }
  };

  const filteredMessages = getFilteredMessages(activeConnectionId);

  return (
    <div className="flex-1 flex flex-col">
      {/* Connection Zone */}
      <div className="border-b border-border bg-surface-2">
        {/* Status + URL row */}
        <div className="flex items-center gap-2 px-3 h-8 border-b border-border/50">
          <div className={cn('h-2 w-2 rounded-full shrink-0', getStatusDotClass())} aria-hidden="true" />
          <span className="text-xs font-mono text-muted-foreground">{getStatusText()}</span>
          {connection.status === 'reconnecting' && (
            <RefreshCw className="h-3 w-3 animate-spin text-amber-400" />
          )}
        </div>
        <div className="flex items-center gap-1 px-3 h-12">
          <span className="text-muted-foreground/40 font-mono text-sm select-none shrink-0">›</span>
          <Input
            value={connection.url}
            onChange={(e) => updateConnectionUrl(activeConnectionId, e.target.value)}
            placeholder="ws://localhost:8080 or wss://example.com/socket"
            className="flex-1 h-7 bg-transparent border-0 font-mono text-sm px-2 focus-visible:ring-0 focus-visible:ring-offset-0"
            disabled={isConnected || isConnecting}
            aria-label="WebSocket URL"
          />
          {!isConnected && !isConnecting ? (
            <Button
              variant="glow"
              size="sm"
              onClick={handleConnect}
              disabled={!connection.url}
              className="h-7 min-w-[80px] shrink-0"
            >
              Connect
            </Button>
          ) : (
            <Button
              variant="destructive"
              size="sm"
              onClick={handleDisconnect}
              className="h-7 min-w-[80px] shrink-0"
            >
              Disconnect
            </Button>
          )}
        </div>
        <div className="flex items-center gap-4 px-3 pb-2">
          <div className="flex items-center gap-2">
            <Switch
              id="auto-reconnect"
              checked={connection.autoReconnect}
              onCheckedChange={(checked) => setAutoReconnect(activeConnectionId, checked)}
              disabled={isConnected}
            />
            <Label htmlFor="auto-reconnect" className="text-xs font-mono cursor-pointer">
              Auto-reconnect
            </Label>
          </div>
          <div className="flex items-center gap-2 flex-1">
            <Label htmlFor="protocols" className="text-xs font-mono whitespace-nowrap text-muted-foreground">
              Protocols:
            </Label>
            <Input
              id="protocols"
              value={connection.protocols.join(', ')}
              onChange={(e) => {
                const protocols = e.target.value.split(',').map((p) => p.trim()).filter((p) => p.length > 0);
                setProtocols(activeConnectionId, protocols);
              }}
              placeholder="e.g., graphql-ws, chat"
              className="h-6 text-xs font-mono flex-1"
              disabled={isConnected || isConnecting}
            />
          </div>
        </div>
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col overflow-hidden">
        <TabsList className="w-full justify-start border-b border-border rounded-none h-9 bg-transparent p-0 shrink-0">
          <TabsTrigger
            value="messages"
            className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none h-9 px-4 font-mono text-xs"
          >
            Messages
            {connection.messages.length > 0 && (
              <span className="ml-1 text-[10px] text-muted-foreground">({connection.messages.length})</span>
            )}
          </TabsTrigger>
          <TabsTrigger
            value="headers"
            className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none h-9 px-4 font-mono text-xs"
          >
            Headers
            {connection.headers.filter((h) => h.enabled).length > 0 && (
              <span className="ml-1 text-[10px] text-muted-foreground">
                ({connection.headers.filter((h) => h.enabled).length})
              </span>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="messages" className="flex-1 flex flex-col m-0 overflow-hidden">
          {/* Filter Bar */}
          <div className="px-3 py-1.5 border-b border-border flex gap-2 items-center shrink-0">
            <Select
              value={messageFilter}
              onValueChange={(value) => setMessageFilter(value as WebSocketMessageType | 'all')}
            >
              <SelectTrigger className="w-28 h-7 text-xs font-mono">
                <SelectValue placeholder="Filter" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="sent">Sent</SelectItem>
                <SelectItem value="received">Received</SelectItem>
                <SelectItem value="system">System</SelectItem>
              </SelectContent>
            </Select>
            <div className="relative flex-1">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search messages..."
                className="pl-7 h-7 text-xs font-mono"
              />
            </div>
            <div className="text-[10px] text-muted-foreground font-mono flex items-center gap-3 shrink-0">
              <span>{connection.messages.length} msgs</span>
              {connectionDuration > 0 && <span>{formatDuration(connectionDuration)}</span>}
            </div>
            <Button
              variant="ghost"
              size="icon"
              onClick={handleExportMessages}
              disabled={connection.messages.length === 0}
              title="Export messages as JSON"
              className="h-7 w-7"
            >
              <Download className="h-3.5 w-3.5" />
            </Button>
          </div>

          {/* Messages */}
          <ScrollArea className="flex-1 p-3">
            <div className="space-y-1 font-mono text-xs">
              {filteredMessages.length === 0 ? (
                <div className="text-center text-muted-foreground/50 py-8 font-mono text-xs">
                  {connection.messages.length === 0
                    ? 'No messages yet. Connect and start sending.'
                    : 'No messages match the current filter.'}
                </div>
              ) : (
                filteredMessages.map((msg) => (
                  <div
                    key={msg.id}
                    className={cn('flex gap-3 p-2 rounded', getMessageRowClass(msg.type))}
                  >
                    <span className="text-[10px] text-muted-foreground/60 shrink-0 mt-0.5 tabular-nums">
                      {formatTime(msg.timestamp)}
                    </span>
                    <span className={cn('text-[10px] font-bold shrink-0 mt-0.5 tracking-wider', getMessageLabelClass(msg.type))}>
                      {getMessageLabel(msg.type)}
                    </span>
                    {msg.dataType === 'binary' && (
                      <Binary className="h-3 w-3 text-primary/60 shrink-0 mt-0.5" />
                    )}
                    <pre className="flex-1 whitespace-pre-wrap break-words text-[11px]">
                      {msg.content}
                    </pre>
                  </div>
                ))
              )}
            </div>
          </ScrollArea>

          {/* Message Input */}
          <div className="px-3 py-2 border-t border-border shrink-0">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-4">
                <span className="text-xs font-mono text-muted-foreground uppercase tracking-widest">Send</span>
                <div className="flex items-center gap-2">
                  <Switch
                    id="send-binary"
                    checked={sendAsBinary}
                    onCheckedChange={setSendAsBinary}
                    disabled={!isConnected}
                  />
                  <Label htmlFor="send-binary" className="text-xs font-mono cursor-pointer">
                    Binary (hex)
                  </Label>
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleClearMessages}
                disabled={connection.messages.length === 0}
                className="h-6 text-xs"
              >
                <Trash2 className="h-3 w-3 mr-1" />
                Clear
              </Button>
            </div>
            <div className="flex gap-2">
              <Textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder={sendAsBinary ? 'Enter hex bytes (e.g., 48 65 6c 6c 6f)...' : 'Enter message to send...'}
                className="flex-1 bg-background border-border font-mono text-xs resize-none"
                rows={3}
                disabled={!isConnected}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && e.ctrlKey) {
                    handleSendMessage();
                  }
                }}
              />
              <Button
                variant="glow"
                onClick={handleSendMessage}
                disabled={!isConnected || !message.trim()}
                className="h-auto px-3 self-stretch"
              >
                <Send className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-[10px] text-muted-foreground/50 font-mono mt-1">Ctrl+Enter to send</p>
          </div>
        </TabsContent>

        <TabsContent value="headers" className="flex-1 overflow-auto p-4 m-0">
          <div className="flex items-start gap-2 p-3 rounded bg-amber-500/5 border border-amber-500/20 mb-4">
            <AlertTriangle className="h-3.5 w-3.5 text-amber-400 shrink-0 mt-0.5" />
            <p className="text-xs text-muted-foreground font-mono">
              The browser WebSocket API does not support custom headers. Headers saved here are for reference only and are not sent with the connection. Use the Electron app for header support.
            </p>
          </div>
          <div className={cn('space-y-2', (isConnected || isConnecting) && 'opacity-50 pointer-events-none')}>
            {connection.headers.map((header) => (
              <div key={header.id} className="flex items-center gap-2 group py-1.5 px-2 rounded hover:bg-surface-2 transition-colors">
                <Input
                  value={header.key}
                  onChange={(e) => handleUpdateHeader(header.id, { key: e.target.value })}
                  placeholder="Key"
                  className="flex-1 bg-background border-border font-mono text-xs"
                />
                <Input
                  value={header.value}
                  onChange={(e) => handleUpdateHeader(header.id, { value: e.target.value })}
                  placeholder="Value"
                  className="flex-1 bg-background border-border font-mono text-xs"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => handleDeleteHeader(header.id)}
                  className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
            <Button onClick={handleAddHeader} variant="outline" size="sm" className="border-border">
              <Plus className="mr-2 h-4 w-4" />
              Add Header
            </Button>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default withErrorBoundary(WebSocketClient);
