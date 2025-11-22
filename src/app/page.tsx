'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import RequestBuilder from '@/features/http/components/RequestBuilder';
import GrpcRequestBuilder from '@/features/grpc/components/GrpcRequestBuilder';
import GraphQLRequestBuilder from '@/features/graphql/components/GraphQLRequestBuilder';
import WebSocketClient from '@/features/websocket/components/WebSocketClient';
import ResponseViewer from '@/components/shared/ResponseViewer';
import ConsolePane from '@/components/shared/ConsolePane';
import Sidebar from '@/features/collections/components/Sidebar';
import Header from '@/components/shared/Header';
import CommandPalette from '@/components/shared/CommandPalette';
import ClientHydration from '@/components/shared/ClientHydration';
import StatusBar from '@/components/shared/StatusBar';
import KeyboardShortcutsPanel from '@/components/shared/KeyboardShortcutsPanel';
import WelcomeOnboarding from '@/components/shared/WelcomeOnboarding';
import { useRequestStore } from '@/store/useRequestStore';
import { useStoreHydration } from '@/hooks/useStoreHydration';
import { Button } from '@/components/ui/button';
import { PanelLeft, ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '@/lib/shared/utils';

type RequestMode = 'http' | 'grpc' | 'websocket' | 'graphql';

export default function Home() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [consoleExpanded, setConsoleExpanded] = useState(true);
  const [requestMode, setRequestMode] = useState<RequestMode>('http');
  const [envManagerOpen, setEnvManagerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [splitPosition, setSplitPosition] = useState(50); // 50% split
  const isDragging = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  // Trigger store hydration on mount
  useStoreHydration();
  const { scriptResult, setScriptResult } = useRequestStore();

  const allLogs = [
    ...(scriptResult?.preRequest?.logs || []),
    ...(scriptResult?.test?.logs || [])
  ];

  const allTests = scriptResult?.test?.tests;

  const handleClearConsole = () => {
    setScriptResult(null);
  };

  // Handle panel resizing
  const handleResizeStart = useCallback(() => {
    isDragging.current = true;
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  }, []);

  const handleResizeMove = useCallback((e: MouseEvent) => {
    if (!isDragging.current || !containerRef.current) return;

    const container = containerRef.current;
    const rect = container.getBoundingClientRect();
    const newPosition = ((e.clientY - rect.top) / rect.height) * 100;

    // Clamp between 20% and 80%
    setSplitPosition(Math.min(80, Math.max(20, newPosition)));
  }, []);

  const handleResizeEnd = useCallback(() => {
    isDragging.current = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);

  useEffect(() => {
    window.addEventListener('mousemove', handleResizeMove);
    window.addEventListener('mouseup', handleResizeEnd);

    return () => {
      window.removeEventListener('mousemove', handleResizeMove);
      window.removeEventListener('mouseup', handleResizeEnd);
    };
  }, [handleResizeMove, handleResizeEnd]);

  // Keyboard shortcut for toggling sidebar
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd/Ctrl + B to toggle sidebar
      if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
        e.preventDefault();
        setSidebarOpen((prev) => !prev);
      }
      // Cmd/Ctrl + , to open settings
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault();
        setSettingsOpen(true);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleSendRequest = useCallback(() => {
    // This will be handled by RequestBuilder's internal keyboard shortcut
    // We're just providing a callback for the command palette
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      metaKey: true,
      bubbles: true,
    });
    window.dispatchEvent(event);
  }, []);

  const renderRequestBuilder = () => {
    const ResizableLayout = ({ children }: { children: [React.ReactNode, React.ReactNode] }) => (
      <div ref={containerRef} className="flex flex-col h-full">
        <div style={{ height: `${splitPosition}%` }} className="min-h-0 overflow-hidden">
          {children[0]}
        </div>
        <div
          className="h-1.5 bg-border/20 hover:bg-primary/20 cursor-row-resize flex items-center justify-center transition-all duration-200 group shrink-0 relative z-50"
          onMouseDown={handleResizeStart}
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize panels"
          tabIndex={0}
        >
          <div className="h-1 w-8 rounded-full bg-border group-hover:bg-primary/50 transition-colors" />
        </div>
        <div style={{ height: `${100 - splitPosition}%` }} className="min-h-0 overflow-hidden">
          {children[1]}
        </div>
      </div>
    );

    switch (requestMode) {
      case 'http':
        return (
          <ResizableLayout>
            <RequestBuilder />
            <ResponseViewer />
          </ResizableLayout>
        );
      case 'grpc':
        return (
          <ResizableLayout>
            <GrpcRequestBuilder />
            <ResponseViewer />
          </ResizableLayout>
        );
      case 'graphql':
        return (
          <ResizableLayout>
            <GraphQLRequestBuilder />
            <ResponseViewer />
          </ResizableLayout>
        );
      case 'websocket':
        return <WebSocketClient />;
      default:
        return null;
    }
  };

  const hasConsoleContent = allLogs.length > 0 || allTests;

  return (
    <div className="flex h-screen flex-col bg-background relative overflow-hidden">
      <Header
        requestMode={requestMode}
        onRequestModeChange={setRequestMode}
        onOpenEnvironments={() => setEnvManagerOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenImport={() => setImportDialogOpen(true)}
        envManagerOpen={envManagerOpen}
        setEnvManagerOpen={setEnvManagerOpen}
        settingsOpen={settingsOpen}
        setSettingsOpen={setSettingsOpen}
        importDialogOpen={importDialogOpen}
        setImportDialogOpen={setImportDialogOpen}
      />
      <ClientHydration
        fallback={
          <div className="flex flex-1 overflow-hidden">
            <div className="w-72 bg-muted animate-pulse" />
            <main className="flex flex-1 flex-col relative">
              <div className="flex flex-1 items-center justify-center">
                <div className="text-muted-foreground text-sm">Loading...</div>
              </div>
            </main>
          </div>
        }
      >
        <div className="flex flex-1 overflow-hidden">
          {/* Sidebar with collapsible mode */}
          <div className={cn(
            "relative transition-all duration-300 ease-out border-r border-border",
            sidebarOpen ? (sidebarCollapsed ? "w-16" : "w-72") : "w-0"
          )}>
            {sidebarOpen && (
              <Sidebar
                onClose={() => setSidebarOpen(false)}
                isCollapsed={sidebarCollapsed}
                onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
              />
            )}
          </div>

          {/* Sidebar toggle button */}
          {!sidebarOpen && (
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setSidebarOpen(true)}
              className="absolute left-2 top-1/2 -translate-y-1/2 z-20 h-8 w-8 bg-background border border-border shadow-sm hover:shadow-md transition-all"
              title="Open sidebar (⌘B)"
            >
              <PanelLeft className="h-4 w-4" />
            </Button>
          )}

          <main className="flex flex-1 flex-col relative bg-background/50">
            {/* Premium noise texture background */}
            <div className="absolute inset-0 noise-texture opacity-10 pointer-events-none" />

            <div className="flex flex-1 overflow-hidden relative z-10">
              <div className="flex flex-col flex-1">
                {renderRequestBuilder()}
              </div>
            </div>

            {/* Console pane with toggle */}
            {requestMode !== 'websocket' && hasConsoleContent && (
              <div className={cn(
                "shrink-0 relative z-10 transition-all duration-300 ease-out border-t border-border",
                consoleExpanded ? "h-56" : "h-9"
              )}>
                {/* Console toggle header */}
                <div
                  className="absolute top-0 left-0 right-0 h-9 flex items-center justify-between px-3 bg-muted cursor-pointer hover:bg-muted/80 transition-colors"
                  onClick={() => setConsoleExpanded(!consoleExpanded)}
                >
                  <span className="text-xs font-medium text-muted-foreground flex items-center gap-2">
                    Console
                    {allLogs.length > 0 && (
                      <span className="text-xs bg-primary/10 text-primary px-1.5 py-0.5 rounded-full tabular-nums">
                        {allLogs.length} {allLogs.length === 1 ? 'log' : 'logs'}
                      </span>
                    )}
                    {allTests && (
                      <span className={cn(
                        "text-xs px-1.5 py-0.5 rounded-full tabular-nums",
                        allTests.every(t => t.passed)
                          ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                          : "bg-red-500/10 text-red-600 dark:text-red-400"
                      )}>
                        {allTests.filter(t => t.passed).length}/{allTests.length} tests
                      </span>
                    )}
                  </span>
                  <Button variant="ghost" size="icon" className="h-5 w-5">
                    {consoleExpanded ? (
                      <ChevronDown className="h-3.5 w-3.5" />
                    ) : (
                      <ChevronUp className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </div>
                {consoleExpanded && (
                  <div className="h-full pt-9">
                    <ConsolePane logs={allLogs} tests={allTests} onClear={handleClearConsole} />
                  </div>
                )}
              </div>
            )}
          </main>
        </div>
      </ClientHydration>

      {/* Status Bar */}
      <StatusBar />

      {/* Command Palette */}
      <CommandPalette
        onOpenEnvironments={() => setEnvManagerOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenImport={() => setImportDialogOpen(true)}
        onSendRequest={handleSendRequest}
        onChangeMode={setRequestMode}
      />

      {/* Keyboard Shortcuts Panel */}
      <KeyboardShortcutsPanel />

      {/* Welcome Onboarding for First-Time Users */}
      <WelcomeOnboarding />
    </div>
  );
}
