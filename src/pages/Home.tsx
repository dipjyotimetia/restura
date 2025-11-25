import { useState, useEffect, useCallback } from 'react';
import RequestBuilder from '@/features/http/components/RequestBuilder';
import GrpcRequestBuilder from '@/features/grpc/components/GrpcRequestBuilder';
import GraphQLRequestBuilder from '@/features/graphql/components/GraphQLRequestBuilder';
import WebSocketClient from '@/features/websocket/components/WebSocketClient';
import ResponseViewer from '@/components/shared/ResponseViewer';
import NetworkConsole from '@/components/shared/NetworkConsole';
import ResizableLayout from '@/components/shared/ResizableLayout';
import Sidebar from '@/features/collections/components/Sidebar';
import Header from '@/components/shared/Header';
import CommandPalette from '@/components/shared/CommandPalette';
import ClientHydration from '@/components/shared/ClientHydration';
import StatusBar from '@/components/shared/StatusBar';
import KeyboardShortcutsPanel from '@/components/shared/KeyboardShortcutsPanel';
import WelcomeOnboarding from '@/components/shared/WelcomeOnboarding';
import { useRequestStore } from '@/store/useRequestStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useStoreHydration } from '@/hooks/useStoreHydration';
import { Button } from '@/components/ui/button';
import { PanelLeft } from 'lucide-react';
import { cn } from '@/lib/shared/utils';
import { SIDEBAR_WIDTH } from '@/lib/shared/constants';
import type { RequestMode } from '@/types';

export default function Home() {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [requestMode, setRequestMode] = useState<RequestMode>('http');
  const [envManagerOpen, setEnvManagerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [windowWidth, setWindowWidth] = useState(1920);

  // Trigger store hydration on mount
  useStoreHydration();
  const { scriptResult, setScriptResult } = useRequestStore();
  const { settings } = useSettingsStore();

  // Determine effective layout (force vertical on small screens)
  const effectiveLayout = windowWidth < 1280 ? 'vertical' : settings.layoutOrientation;

  // Track window width for responsive layout
  useEffect(() => {
    const handleResize = () => setWindowWidth(window.innerWidth);
    setWindowWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const allLogs = [
    ...(scriptResult?.preRequest?.logs || []),
    ...(scriptResult?.test?.logs || [])
  ];

  const allTests = scriptResult?.test?.tests;

  const handleClearConsole = () => {
    setScriptResult(null);
  };

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
    switch (requestMode) {
      case 'http':
        return (
          <ResizableLayout orientation={effectiveLayout}>
            <RequestBuilder />
            <ResponseViewer />
          </ResizableLayout>
        );
      case 'grpc':
        return (
          <ResizableLayout orientation={effectiveLayout}>
            <GrpcRequestBuilder />
            <ResponseViewer />
          </ResizableLayout>
        );
      case 'graphql':
        return (
          <ResizableLayout orientation={effectiveLayout}>
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

  // Console is always shown now (managed by NetworkConsole component)

  return (
    <div className="flex h-screen flex-col bg-background relative overflow-hidden">
      <Header
        requestMode={requestMode}
        onRequestModeChange={setRequestMode}
        onOpenSettings={() => setSettingsOpen(true)}
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
            sidebarOpen ? (sidebarCollapsed ? SIDEBAR_WIDTH.collapsed : SIDEBAR_WIDTH.expanded) : "w-0"
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

            {/* Console pane */}
            {requestMode !== 'websocket' && (
              <NetworkConsole
                scriptLogs={allLogs}
                tests={allTests}
                onClearScripts={handleClearConsole}
              />
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
