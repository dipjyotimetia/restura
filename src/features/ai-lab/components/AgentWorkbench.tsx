import {
  AGENT_SUITE_SCHEMA_VERSION,
  type AgentBundle,
  AgentBundleSchema,
  type AgentSuite,
  AgentSuiteSchema,
  type ApprovalRequest,
  migrateAgentSuite,
} from '@shared/agent-lab';
import { Bot, Download, Play, Plus, Save, Square, Trash2, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useMcpStore } from '@/features/mcp/store/useMcpStore';
import { useCollectionStore } from '@/store/useCollectionStore';
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

type NormalizedAgentSuite = ReturnType<typeof migrateAgentSuite>;
type NormalizedAgentBundle = AgentBundle & { suite: NormalizedAgentSuite };
type DraftPayload =
  | { bundle: false; value: NormalizedAgentSuite }
  | { bundle: true; value: NormalizedAgentBundle };
type BuilderStep = 'task' | 'model' | 'tools' | 'checks' | 'review';
interface PendingApproval {
  request: ApprovalRequest;
  resolve: (decision: 'approved' | 'denied') => void;
}

const BUILDER_STEPS: Array<{ id: BuilderStep; label: string }> = [
  { id: 'task', label: 'Task' },
  { id: 'model', label: 'Model' },
  { id: 'tools', label: 'Tools & grounding' },
  { id: 'checks', label: 'Checks & budgets' },
  { id: 'review', label: 'Review & export' },
];

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
    grounding: { sourceIds: [], maxBytes: 16_384 },
  };
}

export function AgentWorkbench() {
  const suites = useAiLabStore((state) => state.agentSuites);
  const upsert = useAiLabStore((state) => state.upsertAgentSuite);
  const remove = useAiLabStore((state) => state.removeAgentSuite);
  const providers = useAiLabStore((state) => state.providers);
  const collections = useCollectionStore((state) => state.collections);
  const mcpConnections = useMcpStore((state) => state.connections);
  const openReport = useAiLabUiStore((state) => state.openReport);
  const [activeId, setActiveId] = useState<string | null>(Object.keys(suites)[0] ?? null);
  const [draft, setDraft] = useState(() =>
    JSON.stringify(activeId ? suites[activeId] : starterSuite(providers), null, 2)
  );
  const [message, setMessage] = useState(
    'Schema v3 · selected grounding is sanitized before it reaches a model'
  );
  const [builderStep, setBuilderStep] = useState<BuilderStep>('task');
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const running = useAgentRunLiveStore((state) => state.running);
  const progress = useAgentRunLiveStore((state) => state.progress);
  const runStatus = useAgentRunLiveStore((state) => state.status);
  const completedReport = useAgentRunLiveStore((state) => state.completedReport);
  const persistenceError = useAgentRunLiveStore((state) => state.persistenceError);
  const navigationReportId = useAgentRunLiveStore((state) => state.navigationReportId);
  const fileRef = useRef<HTMLInputElement>(null);
  const seenNavigationReportId = useRef(navigationReportId);
  const pendingApprovalRef = useRef<PendingApproval | null>(null);

  const resolvePendingApproval = (decision: 'approved' | 'denied') => {
    const pending = pendingApprovalRef.current;
    pendingApprovalRef.current = null;
    pending?.resolve(decision);
    setPendingApproval(null);
  };

  useEffect(() => {
    if (navigationReportId && navigationReportId !== seenNavigationReportId.current) {
      seenNavigationReportId.current = navigationReportId;
      openReport(navigationReportId);
    }
  }, [navigationReportId, openReport]);

  useEffect(() => registerAgentRunOwner(), []);
  useEffect(
    () => () => {
      const pending = pendingApprovalRef.current;
      pendingApprovalRef.current = null;
      pending?.resolve('denied');
    },
    []
  );

  const select = (id: string) => {
    setActiveId(id);
    setDraft(JSON.stringify(suites[id], null, 2));
    setMessage('Suite loaded');
  };
  const parseDraftPayload = (): DraftPayload => {
    const raw = JSON.parse(draft);
    const bundle = AgentBundleSchema.safeParse(raw);
    if (!bundle.success)
      return { bundle: false, value: migrateAgentSuite(AgentSuiteSchema.parse(raw)) };
    return {
      bundle: true,
      value: { ...bundle.data, suite: migrateAgentSuite(bundle.data.suite) },
    };
  };
  const save = () => {
    try {
      const parsed = parseDraftPayload();
      if (parsed.bundle) {
        setActiveId(null);
        setDraft(JSON.stringify(parsed.value, null, 2));
        setMessage('Bundle schema-validated; export it to commit with your project');
      } else {
        const suite = parsed.value;
        upsert(suite);
        setActiveId(suite.id);
        setDraft(JSON.stringify(suite, null, 2));
        setMessage('Saved and schema-validated');
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };
  const exportSuite = () => {
    try {
      const parsed = parseDraftPayload();
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(parsed.value, null, 2)], { type: 'application/json' })
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = `${parsed.value.id}.${parsed.bundle ? 'agent-bundle' : 'agent-suite'}.json`;
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
        const parsed = { ...bundle.data, suite: migrateAgentSuite(bundle.data.suite) };
        setActiveId(null);
        setDraft(JSON.stringify(parsed, null, 2));
        setMessage('Bundle imported and schema-validated');
      } else {
        const parsed = migrateAgentSuite(AgentSuiteSchema.parse(raw));
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
      const parsed = parseDraftPayload();
      if (!parsed.bundle) upsert(parsed.value);
      const started = startAgentRun(
        parsed.value,
        providers,
        (request) =>
          new Promise<'approved' | 'denied'>((resolve) => {
            const pending = { request, resolve };
            pendingApprovalRef.current = pending;
            setPendingApproval(pending);
          })
      );
      if (!started)
        setMessage('An agent run is already active. Cancel it before starting another.');
      else if (parsed.bundle) setMessage('Running deterministic fixture bundle');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };
  const toggleGrounding = (sourceId: string) => {
    try {
      const parsed = parseDraftPayload();
      const suite = parsed.bundle ? parsed.value.suite : parsed.value;
      const grounding = suite.grounding;
      const selected = new Set(grounding.sourceIds);
      if (selected.has(sourceId)) selected.delete(sourceId);
      else selected.add(sourceId);
      const nextSuite = { ...suite, grounding: { ...grounding, sourceIds: [...selected] } };
      const next = parsed.bundle ? { ...parsed.value, suite: nextSuite } : nextSuite;
      setDraft(JSON.stringify(next, null, 2));
      setMessage(`Grounding ${selected.has(sourceId) ? 'enabled' : 'disabled'} for ${sourceId}`);
    } catch (error) {
      setMessage(
        `Fix suite JSON before selecting grounding: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };
  const updateGuidedSuite = (
    payload: DraftPayload,
    update: (suite: NormalizedAgentSuite) => NormalizedAgentSuite
  ) => {
    const suite = payload.bundle ? payload.value.suite : payload.value;
    const nextSuite = update(suite);
    setDraft(
      JSON.stringify(payload.bundle ? { ...payload.value, suite: nextSuite } : nextSuite, null, 2)
    );
    setMessage('Builder updated the portable suite');
  };
  let selectedGrounding = new Set<string>();
  let guidedSuite: NormalizedAgentSuite | null = null;
  let guidedPayload: DraftPayload | null = null;
  try {
    const parsed = parseDraftPayload();
    const suite = parsed.bundle ? parsed.value.suite : parsed.value;
    selectedGrounding = new Set(suite.grounding.sourceIds);
    guidedSuite = suite;
    guidedPayload = parsed;
  } catch {
    // Keep the raw JSON editable; source buttons become inactive until valid.
  }

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
              aria-label="Delete suite"
              onClick={() => {
                remove(activeId);
                setActiveId(null);
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
          {running ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                resolvePendingApproval('denied');
                cancelAgentRun();
              }}
            >
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
        <div className="mb-3 rounded-sp-card border border-sp-line bg-sp-surface-lo p-3">
          <div className="flex flex-wrap gap-1" role="tablist" aria-label="Guided suite builder">
            {BUILDER_STEPS.map((step) => (
              <Button
                key={step.id}
                size="sm"
                variant={builderStep === step.id ? 'default' : 'ghost'}
                role="tab"
                aria-selected={builderStep === step.id}
                onClick={() => setBuilderStep(step.id)}
              >
                {step.label}
              </Button>
            ))}
          </div>
          {guidedSuite && guidedPayload ? (
            <GuidedStep
              step={builderStep}
              suite={guidedSuite}
              onChange={(update) => updateGuidedSuite(guidedPayload, update)}
              onExport={exportSuite}
            />
          ) : (
            <p className="mt-3 text-sp-10 text-destructive">
              Fix expert JSON to resume guided editing.
            </p>
          )}
        </div>
        <details className="min-h-0 flex-1 rounded-sp-card border border-sp-line bg-sp-surface-lo">
          <summary className="cursor-pointer px-3 py-2 text-sp-10 font-medium text-sp-muted">
            Advanced JSON · schema-validated portable suite
          </summary>
          <textarea
            aria-label="Agent suite JSON"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            spellCheck={false}
            className="min-h-[18rem] w-full resize-y border-t border-sp-line bg-sp-surface-lo p-4 font-mono text-sp-11 leading-5 text-sp-text outline-none focus:border-sp-accent"
          />
        </details>
        <div className="mt-3 rounded-sp-card border border-sp-line bg-sp-surface-lo p-3">
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <div>
              <h3 className="text-sp-11 font-semibold">Selected grounding</h3>
              <p className="text-sp-9 text-sp-muted">
                Only these sanitized collection summaries or MCP catalogs are added as model
                evidence.
              </p>
            </div>
            <span className="text-sp-9 text-sp-muted">{selectedGrounding.size} selected</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {collections.map((collection) => (
              <Button
                key={collection.id}
                size="sm"
                variant={selectedGrounding.has(collection.id) ? 'default' : 'outline'}
                onClick={() => toggleGrounding(collection.id)}
              >
                Collection · {collection.name}
              </Button>
            ))}
            {Object.values(mcpConnections).map((connection) => (
              <Button
                key={connection.id}
                size="sm"
                variant={selectedGrounding.has(connection.id) ? 'default' : 'outline'}
                onClick={() => toggleGrounding(connection.id)}
              >
                MCP · {(connection.capabilities?.serverName ?? connection.url) || connection.id}
              </Button>
            ))}
            {collections.length === 0 && Object.keys(mcpConnections).length === 0 && (
              <span className="text-sp-9 text-sp-muted">
                Create a collection or MCP connection to make it available for grounding.
              </span>
            )}
          </div>
        </div>
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
        {pendingApproval && (
          <ToolApprovalDialog
            request={pendingApproval.request}
            onResolve={resolvePendingApproval}
          />
        )}
      </section>
    </div>
  );
}

function ToolApprovalDialog({
  request,
  onResolve,
}: {
  request: ApprovalRequest;
  onResolve: (decision: 'approved' | 'denied') => void;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Tool approval"
      className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
    >
      <div className="w-full max-w-lg rounded-sp-card border border-sp-line bg-sp-surface p-4 shadow-sp-float">
        <h3 className="text-sp-13 font-semibold">Tool approval required</h3>
        <p className="mt-1 text-sp-11 text-sp-muted">
          {request.permissionClass} tool · {request.toolName}
        </p>
        <pre className="mt-3 max-h-48 overflow-auto rounded-sp-btn bg-sp-bg p-3 text-sp-10 text-sp-text">
          {JSON.stringify(request.arguments, null, 2)}
        </pre>
        <div className="mt-4 flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={() => onResolve('denied')}>
            Deny tool call
          </Button>
          <Button size="sm" onClick={() => onResolve('approved')}>
            Approve tool call
          </Button>
        </div>
      </div>
    </div>
  );
}

function GuidedStep({
  step,
  suite,
  onChange,
  onExport,
}: {
  step: BuilderStep;
  suite: AgentSuite;
  onChange: (update: (suite: NormalizedAgentSuite) => NormalizedAgentSuite) => void;
  onExport: () => void;
}) {
  // `GuidedStep` receives a suite validated by AgentSuiteSchema, which requires one agent.
  const agent = suite.agents[0]!;
  if (step === 'task') {
    return (
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <label className="text-sp-10 text-sp-muted">
          Suite name
          <input
            aria-label="Suite name"
            value={suite.name}
            onChange={(event) => onChange((current) => ({ ...current, name: event.target.value }))}
            className="mt-1 w-full rounded-sp-btn border border-sp-line bg-sp-bg px-2 py-1.5 text-sp-11 text-sp-text"
          />
        </label>
        <label className="text-sp-10 text-sp-muted">
          Agent instructions
          <textarea
            aria-label="Agent instructions"
            value={agent.instructions}
            onChange={(event) =>
              onChange((current) => ({
                ...current,
                agents: current.agents.map((candidate, index) =>
                  index === 0 ? { ...candidate, instructions: event.target.value } : candidate
                ),
              }))
            }
            className="mt-1 min-h-16 w-full rounded-sp-btn border border-sp-line bg-sp-bg px-2 py-1.5 text-sp-11 text-sp-text"
          />
        </label>
      </div>
    );
  }
  if (step === 'model') {
    return (
      <p className="mt-3 text-sp-10 text-sp-muted">
        Primary model: {agent.model.providerId}/{agent.model.model}. Configure provider credentials
        in Models; suites never contain inline credentials.
      </p>
    );
  }
  if (step === 'tools') {
    return (
      <p className="mt-3 text-sp-10 text-sp-muted">
        Configure saved request and MCP tool sources below, then select only sanitized grounding
        evidence needed for this task.
      </p>
    );
  }
  if (step === 'checks') {
    return (
      <div className="mt-3 flex items-center justify-between gap-3 text-sp-10 text-sp-muted">
        <span>
          Current limits: {agent.limits.maxSteps} steps · {agent.limits.maxWallTimeMs}ms wall time ·{' '}
          {suite.graders.length} graders.
        </span>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            onChange((current) => {
              const id = 'desktop-approval';
              const policies = current.policies ?? [];
              const hasPolicy = policies.some((policy) => policy.id === id);
              return {
                ...current,
                policies: hasPolicy
                  ? policies
                  : [
                      ...policies,
                      {
                        id,
                        name: 'Desktop approval',
                        version: 1,
                        autoApprove: [],
                        ciEligible: false,
                      },
                    ],
                agents: current.agents.map((candidate, index) =>
                  index === 0 ? { ...candidate, policyId: id } : candidate
                ),
              };
            })
          }
        >
          Add approval policy
        </Button>
      </div>
    );
  }
  return (
    <div className="mt-3 flex items-center justify-between gap-3 text-sp-10 text-sp-muted">
      <span>
        Review the generated portable schema before committing it. Sensitive tools remain
        approval-gated outside explicit read-only CI manifests.
      </span>
      <Button size="sm" variant="outline" onClick={onExport}>
        Export portable suite
      </Button>
    </div>
  );
}
