'use client';

import { useState, useRef, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { Send, Circle, Trash2, Plus } from 'lucide-react';
import { KeyValue } from '@/types';
import { v4 as uuidv4 } from 'uuid';

interface WebSocketMessage {
  id: string;
  type: 'sent' | 'received' | 'system';
  content: string;
  timestamp: number;
}

export default function WebSocketClient() {
  const [url, setUrl] = useState('');
  const [message, setMessage] = useState('');
  const [messages, setMessages] = useState<WebSocketMessage[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [headers, setHeaders] = useState<KeyValue[]>([]);
  const [activeTab, setActiveTab] = useState('messages');
  const wsRef = useRef<WebSocket | null>(null);
  const { resolveVariables } = useEnvironmentStore();

  useEffect(() => {
    return () => {
      // Cleanup on unmount
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, []);

  const addMessage = (type: WebSocketMessage['type'], content: string) => {
    const newMessage: WebSocketMessage = {
      id: uuidv4(),
      type,
      content,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, newMessage]);
  };

  const handleConnect = () => {
    try {
      const resolvedUrl = resolveVariables(url);

      // Create WebSocket connection
      const ws = new WebSocket(resolvedUrl);

      ws.onopen = () => {
        setIsConnected(true);
        addMessage('system', 'Connected to ' + resolvedUrl);
      };

      ws.onmessage = (event) => {
        addMessage('received', event.data);
      };

      ws.onerror = (error) => {
        addMessage('system', 'WebSocket error occurred');
        console.error('WebSocket error:', error);
      };

      ws.onclose = (event) => {
        setIsConnected(false);
        addMessage(
          'system',
          `Connection closed (code: ${event.code}, reason: ${event.reason || 'No reason provided'})`
        );
      };

      wsRef.current = ws;
    } catch (error) {
      addMessage('system', `Failed to connect: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  };

  const handleDisconnect = () => {
    if (wsRef.current) {
      wsRef.current.close(1000, 'Client disconnected');
      wsRef.current = null;
    }
  };

  const handleSendMessage = () => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN && message.trim()) {
      wsRef.current.send(message);
      addMessage('sent', message);
      setMessage('');
    }
  };

  const handleClearMessages = () => {
    setMessages([]);
  };

  const handleAddHeader = () => {
    const newHeader: KeyValue = {
      id: uuidv4(),
      key: '',
      value: '',
      enabled: true,
    };
    setHeaders([...headers, newHeader]);
  };

  const handleUpdateHeader = (id: string, updates: Partial<KeyValue>) => {
    setHeaders(headers.map((h) => (h.id === id ? { ...h, ...updates } : h)));
  };

  const handleDeleteHeader = (id: string) => {
    setHeaders(headers.filter((h) => h.id !== id));
  };

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

  const getMessageColor = (type: WebSocketMessage['type']) => {
    switch (type) {
      case 'sent':
        return 'text-blue-600 dark:text-blue-400';
      case 'received':
        return 'text-green-600 dark:text-green-400';
      case 'system':
        return 'text-yellow-600 dark:text-yellow-400';
    }
  };

  const getMessageLabel = (type: WebSocketMessage['type']) => {
    switch (type) {
      case 'sent':
        return 'SENT';
      case 'received':
        return 'RECV';
      case 'system':
        return 'SYS';
    }
  };

  return (
    <div className="flex-1 flex flex-col">
      {/* Connection Bar */}
      <div className="p-4 border-b">
        <div className="flex gap-2 items-center mb-2">
          <Circle
            className={`h-3 w-3 ${isConnected ? 'fill-green-500 text-green-500' : 'fill-gray-400 text-gray-400'}`}
          />
          <span className="text-sm font-medium">
            {isConnected ? 'Connected' : 'Disconnected'}
          </span>
        </div>
        <div className="flex gap-2">
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="ws://localhost:8080 or wss://example.com/socket"
            className="flex-1"
            disabled={isConnected}
          />
          {!isConnected ? (
            <Button onClick={handleConnect} disabled={!url}>
              Connect
            </Button>
          ) : (
            <Button onClick={handleDisconnect} variant="destructive">
              Disconnect
            </Button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col">
        <TabsList className="w-full rounded-none border-b bg-transparent px-4">
          <TabsTrigger value="messages">Messages</TabsTrigger>
          <TabsTrigger value="headers">Headers</TabsTrigger>
        </TabsList>

        <TabsContent value="messages" className="flex-1 flex flex-col m-0">
          {/* Messages Area */}
          <ScrollArea className="flex-1 p-4">
            <div className="space-y-2 font-mono text-sm">
              {messages.length === 0 ? (
                <div className="text-center text-muted-foreground py-8">
                  No messages yet. Connect to a WebSocket server and start sending messages.
                </div>
              ) : (
                messages.map((msg) => (
                  <div key={msg.id} className="flex gap-3 p-2 rounded hover:bg-muted/50">
                    <span className="text-[10px] text-muted-foreground flex-shrink-0 mt-0.5">
                      {formatTime(msg.timestamp)}
                    </span>
                    <span
                      className={`text-[10px] font-bold flex-shrink-0 mt-0.5 ${getMessageColor(msg.type)}`}
                    >
                      {getMessageLabel(msg.type)}
                    </span>
                    <pre className="flex-1 whitespace-pre-wrap break-words">
                      {msg.content}
                    </pre>
                  </div>
                ))
              )}
            </div>
          </ScrollArea>

          {/* Message Input */}
          <div className="p-4 border-t">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium">Send Message</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleClearMessages}
                disabled={messages.length === 0}
              >
                <Trash2 className="h-4 w-4 mr-1" />
                Clear
              </Button>
            </div>
            <div className="flex gap-2">
              <Textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="Enter message to send..."
                className="flex-1"
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
            <div className="text-sm text-muted-foreground mb-4">
              Note: Headers can only be set before connection. WebSocket protocol has limited
              header support.
            </div>
            {headers.map((header) => (
              <div key={header.id} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={header.enabled}
                  onChange={(e) => handleUpdateHeader(header.id, { enabled: e.target.checked })}
                  className="h-4 w-4"
                  disabled={isConnected}
                />
                <Input
                  value={header.key}
                  onChange={(e) => handleUpdateHeader(header.id, { key: e.target.value })}
                  placeholder="Key"
                  className="flex-1"
                  disabled={isConnected}
                />
                <Input
                  value={header.value}
                  onChange={(e) => handleUpdateHeader(header.id, { value: e.target.value })}
                  placeholder="Value"
                  className="flex-1"
                  disabled={isConnected}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => handleDeleteHeader(header.id)}
                  disabled={isConnected}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
            <Button onClick={handleAddHeader} variant="outline" size="sm" disabled={isConnected}>
              <Plus className="mr-2 h-4 w-4" />
              Add Header
            </Button>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
