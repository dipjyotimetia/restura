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
import SettingsDrawer, { type SectionId } from '@/components/shared/SettingsDrawer';
import { TabBar } from '@/components/shared/TabBar';
import WelcomeOnboarding from '@/components/shared/WelcomeOnboarding';
import EnvironmentManager from '@/features/environments/components/EnvironmentManager';
import ImportDialog from '@/components/shared/ImportDialog';
import { useRequestStore } from '@/store/useRequestStore';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useActiveTab } from '@/store/selectors';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useStoreHydration } from '@/hooks/useStoreHydration';
import { useKeybindings } from '@/hooks/useKeybindings';
import { SaveToCollectionDialog } from '@/components/shared/SaveToCollectionDialog';
import { ECHO_URLS } from '@/lib/shared/echo-defaults';
import { isElectron } from '@/lib/shared/platform';
import { lazyComponent } from '@/lib/shared/lazyComponent';
import { useAiChatStore } from '@/features/ai/store';
import type { RequestMode, ActivePanel } from '@/types';

const ChatPanel = lazyComponent(() => import('@/features/ai/components/ChatPanel'));

export default function Home() {
  const [activePanel, setActivePanel] = useState<ActivePanel | null>('collections');
  const [envManagerOpen, setEnvManagerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialSection, setSettingsInitialSection] = useState<SectionId>('general');
  const [paletteOpen, setPaletteOpen] = useState(false);
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
  const openTabWithMode = useRequestStore((s) => s.openTabWithMode);
  const { settings } = useSettingsStore();

  const aiPanelOpen = useAiChatStore((s) => s.panelOpen);
  const setAiPanelOpen = useAiChatStore((s) => s.setPanelOpen);
  const enableAi = isElectron();

  // Ref keeps Cmd+S handler current without listener churn.
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;

  // The workspace mode is now derived per-tab — the active tab's modeOverride
  // (for WS/Socket.IO/Kafka/GraphQL pseudo-modes) takes precedence over its
  // request type. Tab switches naturally restore the correct view.
  const requestMode: RequestMode =
    activeTab?.modeOverride ?? activeTab?.request.type ?? 'http';

  const handleRequestModeChange = useCallback(
    (mode: RequestMode) => {
      if (mode === 'graphql' || mode === 'websocket' || mode === 'socketio' || mode === 'kafka') {
        const tabId = openTabWithMode(mode);
        if (mode === 'graphql') {
          // Seed the URL only when the placeholder still holds the default.
          const state = useRequestStore.getState();
          const current = state.tabs.find((t) => t.id === tabId);
          if (current && (current.request.url === '' || current.request.url === ECHO_URLS.http)) {
            state.updateRequest({ url: ECHO_URLS.graphql });
          }
        }
        return;
      }
      // Real RequestType — open a fresh tab of that type.
      createNewRequest(mode);
    },
    [createNewRequest, openTabWithMode]
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

  // App-level shortcuts. All use allowInInput so they keep working while the
  // user is typing in the URL bar / editors (matching prior behaviour). Cmd+K
  // (command palette) is owned by CommandPalette's own listener.
  useKeybindings([
    {
      combo: 'mod+b',
      allowInInput: true,
      handler: () => setActivePanel((prev) => (prev !== null ? null : 'collections')),
    },
    {
      combo: 'mod+,',
      allowInInput: true,
      handler: () => {
        setSettingsInitialSection('general');
        setSettingsOpen(true);
      },
    },
    {
      combo: 'mod+/',
      allowInInput: true,
      handler: () => {
        setSettingsInitialSection('shortcuts');
        setSettingsOpen(true);
      },
    },
    {
      combo: 'mod+s',
      allowInInput: true,
      handler: () => {
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
      },
    },
  ]);

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
        // gRPC builder owns its own response panel (GrpcResponsePanel) per the
        // 3-column handoff layout in §7. No outer ResizableLayout/ResponseViewer.
        return <GrpcRequestBuilder />;
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
        onOpenEnvSwitcher={() => setEnvManagerOpen(true)}
        onOpenCommandPalette={() => setPaletteOpen(true)}
        onOpenSettings={() => {
          setSettingsInitialSection('general');
          setSettingsOpen(true);
        }}
        onToggleAi={enableAi ? () => setAiPanelOpen(!aiPanelOpen) : undefined}
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
                  onOpenImport={() => setImportDialogOpen(true)}
                />
              </motion.div>
            )}
          </AnimatePresence>
        </ClientHydration>

        <div className="flex flex-1 flex-col min-w-0 overflow-hidden gap-2.5">
          <main aria-label="Request workspace" className="flex flex-1 flex-col min-h-0 overflow-hidden gap-2.5">
            <TabBar
              onSaveToCollection={setSaveDialogTabId}
              onChangeMode={handleRequestModeChange}
            />
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
        {enableAi && aiPanelOpen && <ChatPanel onClose={() => setAiPanelOpen(false)} />}
      </div>

      <StatusBar />

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onOpenEnvironments={() => setEnvManagerOpen(true)}
        onOpenSettings={() => {
          setSettingsInitialSection('general');
          setSettingsOpen(true);
        }}
        onOpenImport={() => setImportDialogOpen(true)}
        onSendRequest={handleSendRequest}
        onChangeMode={handleRequestModeChange}
      />
      <SettingsDrawer
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        initialSection={settingsInitialSection}
      />
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
