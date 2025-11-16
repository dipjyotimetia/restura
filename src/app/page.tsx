'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import RequestBuilder from '@/components/RequestBuilder';
import GrpcRequestBuilder from '@/components/GrpcRequestBuilder';
import WebSocketClient from '@/components/WebSocketClient';
import ResponseViewer from '@/components/ResponseViewer';
import ConsolePane from '@/components/ConsolePane';
import Sidebar from '@/components/Sidebar';
import Header from '@/components/Header';
import CommandPalette from '@/components/CommandPalette';
import ClientHydration from '@/components/ClientHydration';
import { useRequestStore } from '@/store/useRequestStore';
import { useStoreHydration } from '@/hooks/useStoreHydration';
import { Button } from '@/components/ui/button';
import { PanelLeft, ChevronDown, ChevronUp, GripHorizontal } from 'lucide-react';
import { cn } from '@/lib/utils';

type RequestMode = 'http' | 'grpc' | 'websocket';

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
          className="h-2 bg-slate-200/60 dark:bg-slate-700/40 hover:bg-slate-blue-300 dark:hover:bg-slate-blue-700 cursor-row-resize flex items-center justify-center transition-colors group shrink-0"
          onMouseDown={handleResizeStart}
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize panels"
          tabIndex={0}
        >
          <GripHorizontal className="h-3 w-3 text-slate-400 group-hover:text-slate-blue-600 dark:group-hover:text-slate-blue-400" />
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
      case 'websocket':
        return <WebSocketClient />;
      default:
        return null;
    }
  };

  const hasConsoleContent = allLogs.length > 0 || allTests;

  return (
    <div className="flex h-screen flex-col bg-background relative overflow-hidden">
      {/* Animated gradient mesh background for glassmorphism */}
      <div className="gradient-mesh-bg">
        <div className="gradient-orb gradient-orb-1" />
        <div className="gradient-orb gradient-orb-2" />
        <div className="gradient-orb gradient-orb-3" />
      </div>

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
            <div className="w-72 bg-slate-100 dark:bg-slate-800 animate-pulse" />
            <main className="flex flex-1 flex-col relative">
              <div className="flex flex-1 items-center justify-center">
                <div className="text-slate-500 dark:text-slate-400 text-sm">Loading...</div>
              </div>
            </main>
          </div>
        }
      >
        <div className="flex flex-1 overflow-hidden">
          {/* Sidebar with collapsible mode */}
          <div className={cn(
            "relative transition-all duration-300 ease-out",
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
              className="absolute left-2 top-1/2 -translate-y-1/2 z-20 h-8 w-8 bg-white/90 dark:bg-slate-900/90 backdrop-blur-md border border-slate-200 dark:border-slate-700 shadow-elevation-2 hover:shadow-elevation-3 transition-all"
              title="Open sidebar (⌘B)"
            >
              <PanelLeft className="h-4 w-4" />
            </Button>
          )}

          <main className="flex flex-1 flex-col relative">
            {/* Subtle dot pattern background */}
            <div className="absolute inset-0 opacity-[0.015] dark:opacity-[0.03] pointer-events-none">
              <div className="absolute inset-0" style={{
                backgroundImage: `radial-gradient(circle at 1px 1px, currentColor 0.5px, transparent 0)`,
                backgroundSize: '20px 20px'
              }} />
            </div>

            <div className="flex flex-1 overflow-hidden relative z-10">
              <div className="flex flex-col flex-1">
                {renderRequestBuilder()}
              </div>
            </div>

            {/* Console pane with toggle */}
            {requestMode !== 'websocket' && hasConsoleContent && (
              <div className={cn(
                "shrink-0 relative z-10 transition-all duration-300 ease-out border-t border-slate-200/60 dark:border-slate-700/40",
                consoleExpanded ? "h-56" : "h-9"
              )}>
                {/* Console toggle header */}
                <div
                  className="absolute top-0 left-0 right-0 h-9 flex items-center justify-between px-3 bg-slate-50/80 dark:bg-slate-800/80 backdrop-blur-sm cursor-pointer hover:bg-slate-blue-50/50 dark:hover:bg-slate-blue-950/20 transition-colors"
                  onClick={() => setConsoleExpanded(!consoleExpanded)}
                >
                  <span className="text-xs font-medium text-slate-700 dark:text-slate-200 flex items-center gap-2">
                    Console
                    {allLogs.length > 0 && (
                      <span className="text-xs bg-slate-blue-100 dark:bg-slate-blue-900/40 text-slate-blue-700 dark:text-slate-blue-300 px-1.5 py-0.5 rounded-full tabular-nums">
                        {allLogs.length} {allLogs.length === 1 ? 'log' : 'logs'}
                      </span>
                    )}
                    {allTests && (
                      <span className={cn(
                        "text-xs px-1.5 py-0.5 rounded-full tabular-nums",
                        allTests.every(t => t.passed)
                          ? "bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300"
                          : "bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300"
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

      {/* Command Palette */}
      <CommandPalette
        onOpenEnvironments={() => setEnvManagerOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenImport={() => setImportDialogOpen(true)}
        onSendRequest={handleSendRequest}
        onChangeMode={setRequestMode}
      />
    </div>
  );
}
