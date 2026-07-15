import { AGENT_SUITE_SCHEMA_VERSION, AgentBundleSchema, AgentSuiteSchema } from '@shared/agent-lab';
import { Bot, Download, Play, Plus, Save, Square, Trash2, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  cancelAgentRun,
  registerAgentRunOwner,
  retryAgentReportPersistence,
  startAgentRun,
  useAgentRunLiveStore,
} from '../run-engine/agentRunService';
import { useAiLabStore } from '../store/useAiLabStore';
import { useAiLabUiStore } from '../store/useAiLabUiStore';
import type { AiLabProviderConfig } from '../types';

function starterSuite(providers: Record<string, AiLabProviderConfig> = {}) {
  const id = crypto.randomUUID();
  const provider = Object.values(providers)[0];
  return {
    schemaVersion: AGENT_SUITE_SCHEMA_VERSION,
    id,
    name: 'New agent suite',
    mode: 'regression' as const,
    agents: [
      {
        id: 'agent',
        model: {
          providerId: provider?.id ?? 'provider-config-id',
          model: provider?.models[0] ?? 'model-id',
        },
        instructions: 'Complete the task. Use tools when they improve correctness.',
        tools: [],
        limits: { maxSteps: 12, maxWallTimeMs: 120_000, maxToolCalls: 24 },
      },
    ],
    tasks: [{ id: 'case-1', input: [{ type: 'text' as const, text: 'Describe the task.' }] }],
    graders: [],
    trials: 3,
  };
}

export function AgentWorkbench() {
  const suites = useAiLabStore((state) => state.agentSuites);
  const upsert = useAiLabStore((state) => state.upsertAgentSuite);
  const remove = useAiLabStore((state) => state.removeAgentSuite);
  const providers = useAiLabStore((state) => state.providers);
  const openReport = useAiLabUiStore((state) => state.openReport);
  const [activeId, setActiveId] = useState<string | null>(Object.keys(suites)[0] ?? null);
  const [draft, setDraft] = useState(() =>
    JSON.stringify(activeId ? suites[activeId] : starterSuite(providers), null, 2)
  );
  const [message, setMessage] = useState(
    'Schema v2 · credentials must be env or keychain references'
  );
  const running = useAgentRunLiveStore((state) => state.running);
  const progress = useAgentRunLiveStore((state) => state.progress);
  const runStatus = useAgentRunLiveStore((state) => state.status);
  const completedReport = useAgentRunLiveStore((state) => state.completedReport);
  const persistenceError = useAgentRunLiveStore((state) => state.persistenceError);
  const navigationReportId = useAgentRunLiveStore((state) => state.navigationReportId);
  const fileRef = useRef<HTMLInputElement>(null);
  const seenNavigationReportId = useRef(navigationReportId);

  useEffect(() => {
    if (navigationReportId && navigationReportId !== seenNavigationReportId.current) {
      seenNavigationReportId.current = navigationReportId;
      openReport(navigationReportId);
    }
  }, [navigationReportId, openReport]);

  useEffect(() => registerAgentRunOwner(), []);

  const select = (id: string) => {
    setActiveId(id);
    setDraft(JSON.stringify(suites[id], null, 2));
    setMessage('Suite loaded');
  };
  const save = () => {
    try {
      const raw = JSON.parse(draft);
      const bundle = AgentBundleSchema.safeParse(raw);
      if (bundle.success) {
        setActiveId(null);
        setDraft(JSON.stringify(bundle.data, null, 2));
        setMessage('Bundle schema-validated; export it to commit with your project');
      } else {
        const parsed = AgentSuiteSchema.parse(raw);
        upsert(parsed);
        setActiveId(parsed.id);
        setDraft(JSON.stringify(parsed, null, 2));
        setMessage('Saved and schema-validated');
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };
  const exportSuite = () => {
    try {
      const raw = JSON.parse(draft);
      const bundle = AgentBundleSchema.safeParse(raw);
      const parsed = bundle.success ? bundle.data : AgentSuiteSchema.parse(raw);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(parsed, null, 2)], { type: 'application/json' })
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = `${parsed.id}.${bundle.success ? 'agent-bundle' : 'agent-suite'}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };
  const importSuite = async (file: File) => {
    try {
      const raw = JSON.parse(await file.text());
      const bundle = AgentBundleSchema.safeParse(raw);
      if (bundle.success) {
        setActiveId(null);
        setDraft(JSON.stringify(bundle.data, null, 2));
        setMessage('Bundle imported and schema-validated');
      } else {
        const parsed = AgentSuiteSchema.parse(raw);
        upsert(parsed);
        setActiveId(parsed.id);
        setDraft(JSON.stringify(parsed, null, 2));
        setMessage('Imported and schema-validated');
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };
  const run = () => {
    try {
      const raw = JSON.parse(draft);
      const bundle = AgentBundleSchema.safeParse(raw);
      const parsed = bundle.success ? bundle.data : AgentSuiteSchema.parse(raw);
      if (!bundle.success) upsert(parsed);
      const started = startAgentRun(parsed, providers, async (request) =>
        window.confirm(
          `Allow ${request.permissionClass} tool “${request.toolName}”?\n\n${JSON.stringify(request.arguments, null, 2)}`
        )
          ? 'approved'
          : 'denied'
      );
      if (!started)
        setMessage('An agent run is already active. Cancel it before starting another.');
      else if (bundle.success) setMessage('Running deterministic fixture bundle');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="grid h-full grid-cols-[220px_minmax(0,1fr)] bg-sp-bg">
      <aside className="border-r border-sp-line bg-sp-surface-lo p-3">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="text-sp-12 font-semibold">Agent suites</h2>
            <p className="text-sp-9 text-sp-muted">Portable regression specs</p>
          </div>
          <Button
            size="sm"
            variant="ghost"
            aria-label="New suite"
            onClick={() => {
              const suite = starterSuite(providers);
              setActiveId(null);
              setDraft(JSON.stringify(suite, null, 2));
            }}
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>
        <div className="space-y-1">
          {Object.values(suites).map((suite) => (
            <button
              key={suite.id}
              type="button"
              onClick={() => select(suite.id)}
              className="w-full rounded-sp-btn px-2 py-2 text-left text-sp-11 hover:bg-sp-hover"
            >
              <span className="block truncate font-medium">{suite.name}</span>
              <span className="text-sp-9 text-sp-muted">
                {suite.tasks.length} tasks · {suite.trials} trials
              </span>
            </button>
          ))}
        </div>
      </aside>
      <section className="flex min-w-0 flex-col p-4">
        <div className="mb-3 flex items-center gap-2">
          <Bot className="h-4 w-4 text-sp-accent" />
          <div className="mr-auto">
            <h2 className="text-sp-14 font-semibold">Agent Workbench</h2>
            <p className="text-sp-10 text-sp-muted">
              Models, MCP/tools, budgets, trials, graders and approvals in one versioned suite.
            </p>
          </div>
          <input
            ref={fileRef}
            aria-label="Import agent suite"
            className="hidden"
            type="file"
            accept="application/json,.json"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importSuite(file);
              event.target.value = '';
            }}
          />
          <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
            <Upload className="mr-1.5 h-3.5 w-3.5" />
            Import
          </Button>
          <Button size="sm" variant="outline" onClick={exportSuite}>
            <Download className="mr-1.5 h-3.5 w-3.5" />
            Export
          </Button>
          {activeId && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                remove(activeId);
                setActiveId(null);
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
          {running ? (
            <Button size="sm" variant="outline" onClick={cancelAgentRun}>
              <Square className="mr-1.5 h-3.5 w-3.5" />
              Cancel
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={run}>
              <Play className="mr-1.5 h-3.5 w-3.5" />
              Run
            </Button>
          )}
          <Button size="sm" onClick={save}>
            <Save className="mr-1.5 h-3.5 w-3.5" />
            Save suite
          </Button>
        </div>
        <textarea
          aria-label="Agent suite JSON"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          spellCheck={false}
          className="min-h-0 flex-1 resize-none rounded-sp-card border border-sp-line bg-sp-surface-lo p-4 font-mono text-sp-11 leading-5 text-sp-text outline-none focus:border-sp-accent"
        />
        <div className="mt-2 truncate text-sp-10 text-sp-muted" role="status">
          {running || completedReport || runStatus !== 'Ready' ? runStatus : message}
          {persistenceError ? ` · ${persistenceError}` : ''}
          {running && progress > 0 ? ` · ${Math.round(progress * 100)}%` : ''}
          {persistenceError && (
            <Button size="sm" variant="ghost" onClick={() => void retryAgentReportPersistence()}>
              Retry save
            </Button>
          )}
          {completedReport && (
            <Button size="sm" variant="ghost" onClick={() => openReport(completedReport.id)}>
              View report
            </Button>
          )}
        </div>
      </section>
    </div>
  );
}
