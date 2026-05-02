import { useState, useEffect, useCallback } from 'react';
import RequestBuilder from '@/features/http/components/RequestBuilder';
import GrpcRequestBuilder from '@/features/grpc/components/GrpcRequestBuilder';
import GraphQLRequestBuilder from '@/features/graphql/components/GraphQLRequestBuilder';
import WebSocketClient from '@/features/websocket/components/WebSocketClient';
import ResponseViewer from '@/components/shared/ResponseViewer';
import NetworkConsole from '@/components/shared/NetworkConsole';
import ResizableLayout from '@/components/shared/ResizableLayout';
import Sidebar from '@/features/collections/components/Sidebar';
import IconRail from '@/components/shared/IconRail';
import TopBar from '@/components/shared/TopBar';
import CommandPalette from '@/components/shared/CommandPalette';
import ClientHydration from '@/components/shared/ClientHydration';
import StatusBar from '@/components/shared/StatusBar';
import KeyboardShortcutsPanel from '@/components/shared/KeyboardShortcutsPanel';
import WelcomeOnboarding from '@/components/shared/WelcomeOnboarding';
import EnvironmentManager from '@/features/environments/components/EnvironmentManager';
import ImportDialog from '@/components/shared/ImportDialog';
import SettingsDialog from '@/components/shared/SettingsDialog';
import { useRequestStore } from '@/store/useRequestStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useStoreHydration } from '@/hooks/useStoreHydration';
import type { RequestMode, ActivePanel } from '@/types';

export default function Home() {
  const [activePanel, setActivePanel] = useState<ActivePanel | null>('collections');
  const [requestMode, setRequestMode] = useState<RequestMode>('http');
  const [envManagerOpen, setEnvManagerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [windowWidth, setWindowWidth] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth : 1920
  );

  useStoreHydration();
  const { scriptResult, setScriptResult } = useRequestStore();
  const { settings } = useSettingsStore();

  const effectiveLayout = windowWidth < 1280 ? 'vertical' : settings.layoutOrientation;

  useEffect(() => {
    const handleResize = () => setWindowWidth(window.innerWidth);
    setWindowWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const allLogs = [
    ...(scriptResult?.preRequest?.logs ?? []),
    ...(scriptResult?.test?.logs ?? []),
  ];

  const allTests = scriptResult?.test?.tests;

  const handleClearConsole = () => {
    setScriptResult(null);
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
        e.preventDefault();
        setActivePanel((prev) => (prev !== null ? null : 'collections'));
      }
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault();
        setSettingsOpen(true);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleSendRequest = useCallback(() => {
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

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <IconRail
        activePanel={activePanel}
        onPanelChange={(panel) => setActivePanel((prev) => (prev === panel ? null : panel))}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <ClientHydration fallback={<div className="w-60 bg-muted/30 animate-pulse border-r border-border" />}>
        {activePanel !== null && (
          <div className="w-60 shrink-0 border-r border-border flex flex-col overflow-hidden">
            <Sidebar
              activePanel={activePanel}
              onClose={() => setActivePanel(null)}
            />
          </div>
        )}
      </ClientHydration>

      <div className="flex flex-1 flex-col min-w-0 overflow-hidden">
        <TopBar
          requestMode={requestMode}
          onRequestModeChange={setRequestMode}
          onOpenImport={() => setImportDialogOpen(true)}
          setEnvManagerOpen={setEnvManagerOpen}
        />

        <main className="flex flex-1 flex-col min-h-0 overflow-hidden">
          <div className="flex flex-1 flex-col min-h-0">
            {renderRequestBuilder()}
          </div>
          {requestMode !== 'websocket' && (
            <NetworkConsole
              scriptLogs={allLogs}
              tests={allTests}
              onClearScripts={handleClearConsole}
            />
          )}
        </main>
      </div>

      <StatusBar />

      <CommandPalette
        onOpenEnvironments={() => setEnvManagerOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenImport={() => setImportDialogOpen(true)}
        onSendRequest={handleSendRequest}
        onChangeMode={setRequestMode}
      />
      <KeyboardShortcutsPanel />
      <WelcomeOnboarding />

      {/* Dialogs */}
      <EnvironmentManager open={envManagerOpen} onOpenChange={setEnvManagerOpen} />
      <ImportDialog open={importDialogOpen} onOpenChange={setImportDialogOpen} />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  );
}
