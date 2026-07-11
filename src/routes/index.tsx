import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { toast } from 'sonner';
import {
  BugReportDialog,
  type BugReportSubmission,
  type BugReportScreenshot,
} from '@/components/shared/BugReportDialog';
import ClientHydration from '@/components/shared/ClientHydration';
import CommandPalette from '@/components/shared/CommandPalette';
import ConsoleDrawer from '@/components/shared/ConsoleDrawer';
import ImportDialog from '@/components/shared/ImportDialog';
import ResizableLayout from '@/components/shared/ResizableLayout';
import ResponseViewer from '@/components/shared/ResponseViewer';
import { SaveToCollectionDialog } from '@/components/shared/SaveToCollectionDialog';
import SettingsDrawer, { type SectionId } from '@/components/shared/SettingsDrawer';
import Sidebar from '@/components/shared/Sidebar';
import StatusBar from '@/components/shared/StatusBar';
import { TabBar } from '@/components/shared/TabBar';
import TopBar from '@/components/shared/TopBar';
import WelcomeOnboarding from '@/components/shared/WelcomeOnboarding';
import { motion } from '@/components/ui/motion';
import { useAiChatStore } from '@/features/ai/store';
import { saveTabBackToCollection } from '@/features/collections/lib/saveBack';
import EnvironmentManager from '@/features/environments/components/EnvironmentManager';
import RequestBuilder from '@/features/http/components/RequestBuilder';
import { useKeybindings } from '@/hooks/useKeybindings';
import { useStoreHydration } from '@/hooks/useStoreHydration';
import {
  buildBugReportMarkdown,
  buildGitHubBugReportUrl,
  type BugReportDiagnostics,
} from '@/lib/shared/bug-report';
import {
  captureBugReportScreenshot,
  collectBugReportDiagnostics,
  copyBugReportScreenshot,
} from '@/lib/shared/bug-report-client';
import { ECHO_URLS } from '@/lib/shared/echo-defaults';
import { lazyComponent } from '@/lib/shared/lazyComponent';
import { isElectron, onMenuEvent, openExternalUrl } from '@/lib/shared/platform';
import { useActiveTab } from '@/store/selectors';
import { useRequestStore } from '@/store/useRequestStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import type { RequestMode, ActivePanel } from '@/types';
import { isConnectionMode } from '@/types';

const ChatPanel = lazyComponent(() => import('@/features/ai/components/ChatPanel'));

// HTTP is the default mode and stays eager (imported above). The other seven
// protocol builders are split into their own chunks so they're only fetched
// when the user actually switches into that mode — this keeps them (and their
// transitive deps: socket.io-client, graphql, the Kafka/MCP UI trees) out of
// the renderer entry chunk that V8 parses at desktop startup.
const GrpcRequestBuilder = lazyComponent(
  () => import('@/features/grpc/components/GrpcRequestBuilder')
);
const GrpcResponsePanel = lazyComponent(
  () => import('@/features/grpc/components/GrpcResponsePanel')
);
const GraphQLRequestBuilder = lazyComponent(
  () => import('@/features/graphql/components/GraphQLRequestBuilder')
);
const WebSocketClient = lazyComponent(
  () => import('@/features/websocket/components/WebSocketClient')
);
const SocketIOClient = lazyComponent(() => import('@/features/socketio/components/SocketIOClient'));
const SseClient = lazyComponent(() => import('@/features/sse/components/SseClient'));
const McpRequestBuilder = lazyComponent(
  () => import('@/features/mcp/components/McpRequestBuilder')
);
const McpResultPanel = lazyComponent(() => import('@/features/mcp/components/McpResultPanel'));
const KafkaClient = lazyComponent(() => import('@/features/kafka/components/KafkaClient'));
const MqttClient = lazyComponent(() => import('@/features/mqtt/components/MqttClient'));

export default function Home() {
  const [activePanel] = useState<ActivePanel>('collections');
  const [envManagerOpen, setEnvManagerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialSection, setSettingsInitialSection] = useState<SectionId>('general');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [saveDialogTabId, setSaveDialogTabId] = useState<string | null>(null);
  const [bugReportOpen, setBugReportOpen] = useState(false);
  const [bugReportScreenshot, setBugReportScreenshot] = useState<BugReportScreenshot>();
  const [bugReportDiagnostics, setBugReportDiagnostics] = useState<BugReportDiagnostics>();
  const [bugReportCaptureError, setBugReportCaptureError] = useState<string>();
  const [bugReportDiagnosticsError, setBugReportDiagnosticsError] = useState<string>();
  const [windowWidth, setWindowWidth] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth : 1920
  );

  useStoreHydration();
  const activeTab = useActiveTab();
  const scriptResult = activeTab?.scriptResult ?? null;
  const setScriptResult = useRequestStore((s) => s.setScriptResult);
  const createNewRequest = useRequestStore((s) => s.createNewRequest);
  const openTabWithMode = useRequestStore((s) => s.openTabWithMode);
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);

  const aiPanelOpen = useAiChatStore((s) => s.panelOpen);
  const setAiPanelOpen = useAiChatStore((s) => s.setPanelOpen);
  const enableAi = isElectron();

  // Ref keeps Cmd+S handler current without listener churn.
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;

  // The workspace mode is now derived per-tab — the active tab's modeOverride
  // (for WS/Socket.IO/Kafka/GraphQL pseudo-modes) takes precedence over its
  // request type. Tab switches naturally restore the correct view.
  const requestMode: RequestMode = activeTab?.modeOverride ?? activeTab?.request.type ?? 'http';

  const handleRequestModeChange = useCallback(
    (mode: RequestMode) => {
      if (isConnectionMode(mode)) {
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

  // Persisted request/response split (shared by every split protocol view).
  const handleSplitChange = useCallback(
    (split: number) => updateSettings({ requestResponseSplit: split }),
    [updateSettings]
  );
  const splitProps = {
    orientation: effectiveLayout,
    split: settings.requestResponseSplit ?? 50,
    onSplitChange: handleSplitChange,
  };

  useEffect(() => {
    const handleResize = () => setWindowWidth(window.innerWidth);
    setWindowWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const allLogs = useMemo(
    () => [...(scriptResult?.preRequest?.logs ?? []), ...(scriptResult?.test?.logs ?? [])],
    [scriptResult]
  );

  const allTests = useMemo(() => scriptResult?.test?.tests, [scriptResult]);

  const handleClearConsole = () => {
    setScriptResult(null);
  };

  // App-level shortcuts. All use allowInInput so they keep working while the
  // user is typing in the URL bar / editors (matching prior behaviour). Cmd+K
  // (command palette) is owned by CommandPalette's own listener.
  useKeybindings([
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
          if (saveTabBackToCollection(tab.request, tab.savedRequestId)) {
            useRequestStore.getState().clearTabDirty(tab.id);
          }
        } else {
          setSaveDialogTabId(tab.id);
        }
      },
    },
    {
      combo: 'mod+n',
      allowInInput: true,
      handler: () => {
        createNewRequest('http');
      },
    },
  ]);

  // Native "Settings/Preferences" menu item (Electron) → open the drawer. The
  // mod+, keybinding above covers the web build, where there is no native menu.
  useEffect(
    () =>
      onMenuEvent('menu:settings', () => {
        setSettingsInitialSection('general');
        setSettingsOpen(true);
      }),
    []
  );

  const handleOpenBugReport = useCallback(async () => {
    setBugReportScreenshot(undefined);
    setBugReportDiagnostics(undefined);
    setBugReportCaptureError(undefined);
    setBugReportDiagnosticsError(undefined);
    const [capture, diagnostics] = await Promise.allSettled([
      captureBugReportScreenshot(),
      collectBugReportDiagnostics(),
    ]);
    if (capture.status === 'fulfilled') {
      setBugReportScreenshot(capture.value.screenshot);
      setBugReportCaptureError(capture.value.error);
    } else {
      setBugReportCaptureError('Screenshot capture failed.');
    }
    if (diagnostics.status === 'fulfilled') {
      setBugReportDiagnostics(diagnostics.value);
    } else {
      setBugReportDiagnosticsError('Diagnostics could not be collected.');
    }
    setBugReportOpen(true);
  }, []);

  useEffect(
    () => onMenuEvent('menu:report-bug', () => void handleOpenBugReport()),
    [handleOpenBugReport]
  );

  const handleOpenGitHubDraft = useCallback(async (submission: BugReportSubmission) => {
    let screenshotCopied = false;
    if (submission.screenshot) {
      try {
        await copyBugReportScreenshot(submission.screenshot.imageDataUrl);
        screenshotCopied = true;
      } catch (error) {
        toast.warning(
          error instanceof Error
            ? `${error.message} The issue draft will open without it.`
            : 'The screenshot could not be copied.'
        );
      }
    }
    const draft = {
      title: submission.title,
      description: submission.description,
      steps: submission.steps,
      expected: submission.expected,
      actual: submission.actual,
      ...(submission.diagnostics ? { diagnostics: submission.diagnostics } : {}),
      hasScreenshot: screenshotCopied,
    };
    const markdown = buildBugReportMarkdown(draft);
    try {
      await navigator.clipboard.writeText(markdown);
    } catch {
      toast.warning('The issue text could not be copied, but GitHub will still be prefilled.');
    }
    await openExternalUrl(buildGitHubBugReportUrl(draft));
    setBugReportOpen(false);
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
          <ResizableLayout {...splitProps}>
            <RequestBuilder />
            <ResponseViewer />
          </ResizableLayout>
        );
      case 'grpc':
        return (
          <ResizableLayout {...splitProps}>
            <GrpcRequestBuilder />
            <GrpcResponsePanel />
          </ResizableLayout>
        );
      case 'graphql':
        return (
          <ResizableLayout {...splitProps}>
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
        return (
          <ResizableLayout {...splitProps}>
            <McpRequestBuilder />
            <McpResultPanel />
          </ResizableLayout>
        );
      case 'kafka':
        return <KafkaClient />;
      case 'mqtt':
        return <MqttClient />;
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
        onOpenBugReport={() => void handleOpenBugReport()}
      />

      <div className="flex flex-1 overflow-hidden min-h-0">
        <ClientHydration
          fallback={<div className="w-67 shrink-0 animate-pulse rounded-sp-panel" />}
        >
          <motion.div
            key="sidebar-panel"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 268, opacity: 1 }}
            transition={{ duration: 0.18, ease: [0.4, 0, 0.2, 1] }}
            className="shrink-0 overflow-hidden"
          >
            <Sidebar activePanel={activePanel} onOpenImport={() => setImportDialogOpen(true)} />
          </motion.div>
        </ClientHydration>

        <div className="flex flex-1 flex-col min-w-0 overflow-hidden">
          <main
            aria-label="Request workspace"
            className="flex flex-1 flex-col min-h-0 overflow-hidden"
          >
            <TabBar
              onSaveToCollection={setSaveDialogTabId}
              onChangeMode={handleRequestModeChange}
            />
            <div className="flex flex-1 flex-col min-h-0">{renderRequestBuilder()}</div>
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
      <BugReportDialog
        open={bugReportOpen}
        onOpenChange={setBugReportOpen}
        screenshot={bugReportScreenshot}
        diagnostics={bugReportDiagnostics}
        captureError={bugReportCaptureError}
        diagnosticsError={bugReportDiagnosticsError}
        onOpenGitHubDraft={handleOpenGitHubDraft}
      />
      {saveDialogTabId && (
        <SaveToCollectionDialog
          tabId={saveDialogTabId}
          open={true}
          onOpenChange={(o) => {
            if (!o) setSaveDialogTabId(null);
          }}
        />
      )}
    </div>
  );
}
