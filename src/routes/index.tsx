import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { AnimatePresence, motion } from '@/components/ui/motion';
import RequestBuilder from '@/features/http/components/RequestBuilder';
import GrpcRequestBuilder from '@/features/grpc/components/GrpcRequestBuilder';
import GraphQLRequestBuilder from '@/features/graphql/components/GraphQLRequestBuilder';
import WebSocketClient from '@/features/websocket/components/WebSocketClient';
import SocketIOClient from '@/features/socketio/components/SocketIOClient';
import SseClient from '@/features/sse/components/SseClient';
import McpRequestBuilder from '@/features/mcp/components/McpRequestBuilder';
import KafkaClient from '@/features/kafka/components/KafkaClient';
import ResponseViewer from '@/components/shared/ResponseViewer';
import ConsoleDrawer from '@/components/shared/ConsoleDrawer';
import ResizableLayout from '@/components/shared/ResizableLayout';
import Sidebar from '@/components/shared/Sidebar';
import TopBar from '@/components/shared/TopBar';
import CommandPalette from '@/components/shared/CommandPalette';
import ClientHydration from '@/components/shared/ClientHydration';
import StatusBar from '@/components/shared/StatusBar';
import SettingsDrawer from '@/components/shared/SettingsDrawer';
import { TabBar } from '@/components/shared/TabBar';
import WelcomeOnboarding from '@/components/shared/WelcomeOnboarding';
import EnvironmentManager from '@/features/environments/components/EnvironmentManager';
import ImportDialog from '@/components/shared/ImportDialog';
import { useRequestStore } from '@/store/useRequestStore';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useActiveTab } from '@/store/selectors';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useStoreHydration } from '@/hooks/useStoreHydration';
import { SaveToCollectionDialog } from '@/components/shared/SaveToCollectionDialog';
import { ECHO_URLS } from '@/lib/shared/echo-defaults';
import type { RequestMode, ActivePanel } from '@/types';

export default function Home() {
  const [activePanel, setActivePanel] = useState<ActivePanel | null>('collections');
  // Optional override for modes that don't map 1:1 to a RequestType (graphql, websocket).
  const [modeOverride, setModeOverride] = useState<RequestMode | null>(null);
  const [envManagerOpen, setEnvManagerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [saveDialogTabId, setSaveDialogTabId] = useState<string | null>(null);
  const [windowWidth, setWindowWidth] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth : 1920
  );

  useStoreHydration();
  const activeTab = useActiveTab();
  const scriptResult = activeTab?.scriptResult ?? null;
  const setScriptResult = useRequestStore((s) => s.setScriptResult);
  const createNewRequest = useRequestStore((s) => s.createNewRequest);
  const { settings } = useSettingsStore();

  // Ref keeps Cmd+S handler current without listener churn.
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;

  const requestMode: RequestMode = modeOverride ?? activeTab?.request.type ?? 'http';

  const handleRequestModeChange = useCallback(
    (mode: RequestMode) => {
      const needsHttpTab = mode === 'graphql' || mode === 'websocket' || mode === 'kafka' || mode === 'socketio';
      if (!needsHttpTab) {
        setModeOverride(null);
        if (activeTab?.request.type !== mode) createNewRequest(mode);
        return;
      }
      setModeOverride(mode);
      if (mode !== 'graphql') return;
      if (activeTab?.request.type !== 'http') createNewRequest('http');
      const state = useRequestStore.getState();
      const current = state.getActiveTab();
      if (current?.request.type !== 'http') return;
      const { url } = current.request;
      if (url === ECHO_URLS.graphql) return;
      if (url !== '' && url !== ECHO_URLS.http) return;
      state.updateRequest({ url: ECHO_URLS.graphql });
    },
    [activeTab?.request.type, createNewRequest]
  );

  const effectiveLayout = windowWidth < 1280 ? 'vertical' : settings.layoutOrientation;

  useEffect(() => {
    const handleResize = () => setWindowWidth(window.innerWidth);
    setWindowWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const allLogs = useMemo(() => [
    ...(scriptResult?.preRequest?.logs ?? []),
    ...(scriptResult?.test?.logs ?? []),
  ], [scriptResult]);

  const allTests = useMemo(() => scriptResult?.test?.tests, [scriptResult]);

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
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        const tab = activeTabRef.current;
        if (!tab?.isDirty) return;
        if (tab.savedRequestId) {
          useCollectionStore.getState().updateAnyCollectionItem(tab.savedRequestId, {
            name: tab.request.name,
            request: tab.request,
          });
          useRequestStore.getState().clearTabDirty(tab.id);
        } else {
          setSaveDialogTabId(tab.id);
        }
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
      case 'socketio':
        return <SocketIOClient />;
      case 'sse':
        return <SseClient />;
      case 'mcp':
        return <McpRequestBuilder />;
      case 'kafka':
        return <KafkaClient />;
      default:
        return null;
    }
  };

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      {/* WindowChrome — fixed 44px top bar. The Sidebar lives below it so
          the chrome spans the full window width per design §3. */}
      <TopBar
        requestMode={requestMode}
        onRequestModeChange={handleRequestModeChange}
        onOpenImport={() => setImportDialogOpen(true)}
        setEnvManagerOpen={setEnvManagerOpen}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <div className="flex flex-1 overflow-hidden min-h-0 px-3.5 pb-3 gap-3">
        <ClientHydration
          fallback={<div className="w-67 shrink-0 animate-pulse rounded-sp-panel" />}
        >
          <AnimatePresence initial={false}>
            {activePanel !== null && (
              <motion.div
                key="sidebar-panel"
                initial={{ width: 0, opacity: 0 }}
                animate={{ width: 268, opacity: 1 }}
                exit={{ width: 0, opacity: 0 }}
                transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
                className="shrink-0 overflow-hidden"
              >
                <Sidebar
                  activePanel={activePanel}
                  onClose={() => setActivePanel(null)}
                  onOpenEnvironmentManager={() => setEnvManagerOpen(true)}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </ClientHydration>

        <div className="flex flex-1 flex-col min-w-0 overflow-hidden gap-2.5">
          <main aria-label="Request workspace" className="flex flex-1 flex-col min-h-0 overflow-hidden gap-2.5">
            <TabBar onSaveToCollection={setSaveDialogTabId} />
            <div className="flex flex-1 flex-col min-h-0">
              {renderRequestBuilder()}
            </div>
            <ConsoleDrawer
              scriptLogs={allLogs}
              {...(allTests !== undefined && { tests: allTests })}
              onClearScripts={handleClearConsole}
            />
          </main>
        </div>
      </div>

      <StatusBar />

      <CommandPalette
        onOpenEnvironments={() => setEnvManagerOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenImport={() => setImportDialogOpen(true)}
        onSendRequest={handleSendRequest}
        onChangeMode={handleRequestModeChange}
      />
      <SettingsDrawer open={settingsOpen} onOpenChange={setSettingsOpen} />
      <WelcomeOnboarding />

      {/* Dialogs */}
      <EnvironmentManager open={envManagerOpen} onOpenChange={setEnvManagerOpen} />
      <ImportDialog open={importDialogOpen} onOpenChange={setImportDialogOpen} />
      {saveDialogTabId && (
        <SaveToCollectionDialog
          tabId={saveDialogTabId}
          open={true}
          onOpenChange={(o) => { if (!o) setSaveDialogTabId(null); }}
        />
      )}
    </div>
  );
}
