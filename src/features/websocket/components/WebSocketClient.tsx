'use client';

import { useEffect, useState } from 'react';
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
  Circle,
  Trash2,
  Plus,
  Search,
  RefreshCw,
  Binary,
  Download,
} from 'lucide-react';
import { KeyValue } from '@/types';

// Helper to format duration
const formatDuration = (ms: number): string => {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
};

export default function WebSocketClient() {
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
    deleteHeader,
    setMessageFilter,
    setSearchQuery,
    getFilteredMessages,
    addMessage,
    setProtocols,
  } = useWebSocketStore();

  // Get or create active connection
  const connection = activeConnectionId ? connections[activeConnectionId] : null;

  useEffect(() => {
    // Create default connection if none exists
    if (!activeConnectionId) {
      createConnection();
    }
  }, [activeConnectionId, createConnection]);

  // Cleanup WebSocket connection on component unmount
  useEffect(() => {
    return () => {
      if (activeConnectionId) {
        websocketManager.disconnect(activeConnectionId);
      }
    };
  }, [activeConnectionId]);

  if (!connection || !activeConnectionId) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Button onClick={() => createConnection()}>Create Connection</Button>
      </div>
    );
  }

  const isConnected = connection.status === 'connected';
  const isConnecting =
    connection.status === 'connecting' || connection.status === 'reconnecting';

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
        // Show error for invalid hex format
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
    deleteHeader(activeConnectionId, id);
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

  // Calculate connection duration
  const connectionDuration =
    isConnected && connection.lastConnectedAt
      ? Date.now() - connection.lastConnectedAt
      : 0;

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

  const getMessageColor = (type: WebSocketMessageType) => {
    switch (type) {
      case 'sent':
        return 'text-blue-600 dark:text-blue-400';
      case 'received':
        return 'text-green-600 dark:text-green-400';
      case 'system':
        return 'text-yellow-600 dark:text-yellow-400';
    }
  };

  const getMessageLabel = (type: WebSocketMessageType) => {
    switch (type) {
      case 'sent':
        return 'SENT';
      case 'received':
        return 'RECV';
      case 'system':
        return 'SYS';
    }
  };

  const getStatusColor = () => {
    switch (connection.status) {
      case 'connected':
        return 'fill-green-500 text-green-500';
      case 'connecting':
      case 'reconnecting':
        return 'fill-yellow-500 text-yellow-500';
      default:
        return 'fill-gray-400 text-gray-400';
    }
  };

  const getStatusText = () => {
    switch (connection.status) {
      case 'connected':
        return 'Connected';
      case 'connecting':
        return 'Connecting...';
      case 'reconnecting':
        return `Reconnecting (${connection.reconnectAttempts}/${connection.maxReconnectAttempts})`;
      default:
        return 'Disconnected';
    }
  };

  const filteredMessages = getFilteredMessages(activeConnectionId);

  return (
    <div className="flex-1 flex flex-col">
      {/* Connection Bar */}
      <div className="p-4 border-b border-border">
        <div className="flex gap-2 items-center mb-2">
          <Circle className={`h-3 w-3 ${getStatusColor()}`} />
          <span className="text-sm font-medium">{getStatusText()}</span>
          {connection.status === 'reconnecting' && (
            <RefreshCw className="h-3 w-3 animate-spin text-yellow-500" />
          )}
        </div>
        <div className="flex gap-2">
          <Input
            value={connection.url}
            onChange={(e) => updateConnectionUrl(activeConnectionId, e.target.value)}
            placeholder="ws://localhost:8080 or wss://example.com/socket"
            className="flex-1 bg-background border-border"
            disabled={isConnected || isConnecting}
          />
          {!isConnected && !isConnecting ? (
            <Button onClick={handleConnect} disabled={!connection.url}>
              Connect
            </Button>
          ) : (
            <Button onClick={handleDisconnect} variant="destructive">
              Disconnect
            </Button>
          )}
        </div>
        <div className="flex items-center gap-4 mt-2">
          <div className="flex items-center gap-2">
            <Switch
              id="auto-reconnect"
              checked={connection.autoReconnect}
              onCheckedChange={(checked) =>
                setAutoReconnect(activeConnectionId, checked)
              }
              disabled={isConnected}
            />
            <Label htmlFor="auto-reconnect" className="text-xs">
              Auto-reconnect
            </Label>
          </div>
          <div className="flex items-center gap-2 flex-1">
            <Label htmlFor="protocols" className="text-xs whitespace-nowrap">
              Subprotocols:
            </Label>
            <Input
              id="protocols"
              value={connection.protocols.join(', ')}
              onChange={(e) => {
                const protocols = e.target.value
                  .split(',')
                  .map((p) => p.trim())
                  .filter((p) => p.length > 0);
                setProtocols(activeConnectionId, protocols);
              }}
              placeholder="e.g., graphql-ws, chat"
              className="h-7 text-xs flex-1"
              disabled={isConnected || isConnecting}
            />
          </div>
        </div>
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col">
        <TabsList className="w-full rounded-none border-b border-border bg-transparent px-4">
          <TabsTrigger value="messages">Messages</TabsTrigger>
          <TabsTrigger value="headers">Headers</TabsTrigger>
        </TabsList>

        <TabsContent value="messages" className="flex-1 flex flex-col m-0">
          {/* Filter Bar */}
          <div className="p-2 border-b border-border flex gap-2 items-center">
            <Select
              value={messageFilter}
              onValueChange={(value) =>
                setMessageFilter(value as WebSocketMessageType | 'all')
              }
            >
              <SelectTrigger className="w-32 h-8">
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
              <Search className="absolute left-2 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search messages..."
                className="pl-8 h-8"
              />
            </div>
            {/* Metrics */}
            <div className="text-xs text-muted-foreground flex items-center gap-3">
              <span>{connection.messages.length} msgs</span>
              {connectionDuration > 0 && (
                <span>{formatDuration(connectionDuration)}</span>
              )}
            </div>
            {/* Export */}
            <Button
              variant="ghost"
              size="sm"
              onClick={handleExportMessages}
              disabled={connection.messages.length === 0}
              title="Export messages as JSON"
            >
              <Download className="h-4 w-4" />
            </Button>
          </div>

          {/* Messages Area */}
          <ScrollArea className="flex-1 p-4">
            <div className="space-y-2 font-mono text-sm">
              {filteredMessages.length === 0 ? (
                <div className="text-center text-muted-foreground py-8">
                  {connection.messages.length === 0
                    ? 'No messages yet. Connect to a WebSocket server and start sending messages.'
                    : 'No messages match the current filter.'}
                </div>
              ) : (
                filteredMessages.map((msg) => (
                  <div key={msg.id} className="flex gap-3 p-2 rounded hover:bg-accent">
                    <span className="text-[10px] text-muted-foreground flex-shrink-0 mt-0.5">
                      {formatTime(msg.timestamp)}
                    </span>
                    <span
                      className={`text-[10px] font-bold flex-shrink-0 mt-0.5 ${getMessageColor(msg.type)}`}
                    >
                      {getMessageLabel(msg.type)}
                    </span>
                    {msg.dataType === 'binary' && (
                      <Binary className="h-3 w-3 text-purple-500 flex-shrink-0 mt-0.5" />
                    )}
                    <pre className="flex-1 whitespace-pre-wrap break-words">
                      {msg.content}
                    </pre>
                  </div>
                ))
              )}
            </div>
          </ScrollArea>

          {/* Message Input */}
          <div className="p-4 border-t border-border">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-4">
                <span className="text-sm font-medium">Send Message</span>
                <div className="flex items-center gap-2">
                  <Switch
                    id="send-binary"
                    checked={sendAsBinary}
                    onCheckedChange={setSendAsBinary}
                    disabled={!isConnected}
                  />
                  <Label htmlFor="send-binary" className="text-xs">
                    Binary (hex)
                  </Label>
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleClearMessages}
                disabled={connection.messages.length === 0}
              >
                <Trash2 className="h-4 w-4 mr-1" />
                Clear
              </Button>
            </div>
            <div className="flex gap-2">
              <Textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder={
                  sendAsBinary
                    ? 'Enter hex bytes (e.g., 48 65 6c 6c 6f)...'
                    : 'Enter message to send...'
                }
                className="flex-1 bg-background border-border"
                rows={3}
                disabled={!isConnected}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && e.ctrlKey) {
                    handleSendMessage();
                  }
                }}
              />
              <Button
                onClick={handleSendMessage}
                disabled={!isConnected || !message.trim()}
                className="h-auto"
              >
                <Send className="h-4 w-4" />
              </Button>
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              Ctrl+Enter to send
            </div>
          </div>
        </TabsContent>

        <TabsContent value="headers" className="flex-1 overflow-auto p-4 m-0">
          <div className="space-y-2">
            <div className="text-sm text-muted-foreground mb-4 p-3 bg-yellow-500/10 border border-yellow-500/20 rounded">
              <strong>⚠️ Browser Limitation:</strong> The browser WebSocket API does not support
              custom headers. These headers are saved for reference only and are not sent with
              the connection. For header support, use the Electron desktop app.
            </div>
            {connection.headers.map((header) => (
              <div key={header.id} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={header.enabled}
                  onChange={(e) =>
                    handleUpdateHeader(header.id, { enabled: e.target.checked })
                  }
                  className="h-4 w-4"
                  disabled={isConnected || isConnecting}
                />
                <Input
                  value={header.key}
                  onChange={(e) =>
                    handleUpdateHeader(header.id, { key: e.target.value })
                  }
                  placeholder="Key"
                  className="flex-1"
                  disabled={isConnected || isConnecting}
                />
                <Input
                  value={header.value}
                  onChange={(e) =>
                    handleUpdateHeader(header.id, { value: e.target.value })
                  }
                  placeholder="Value"
                  className="flex-1"
                  disabled={isConnected || isConnecting}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => handleDeleteHeader(header.id)}
                  disabled={isConnected || isConnecting}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
            <Button
              onClick={handleAddHeader}
              variant="outline"
              size="sm"
              disabled={isConnected || isConnecting}
            >
              <Plus className="mr-2 h-4 w-4" />
              Add Header
            </Button>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
