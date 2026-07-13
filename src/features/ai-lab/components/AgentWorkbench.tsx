import { AgentSuiteSchema, AGENT_SUITE_SCHEMA_VERSION } from '@shared/agent-lab';
import { Bot, Download, Loader2, Play, Plus, Save, Trash2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { runDesktopAgentSuite } from '../lib/agentRuntime';
import { useAiLabStore } from '../store/useAiLabStore';
import type { AiLabProviderConfig } from '../types';
import { Button } from '@/components/ui/button';

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
  const [activeId, setActiveId] = useState<string | null>(Object.keys(suites)[0] ?? null);
  const [draft, setDraft] = useState(() =>
    JSON.stringify(activeId ? suites[activeId] : starterSuite(providers), null, 2)
  );
  const [message, setMessage] = useState(
    'Schema v2 · credentials must be env or keychain references'
  );
  const [running, setRunning] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const select = (id: string) => {
    setActiveId(id);
    setDraft(JSON.stringify(suites[id], null, 2));
    setMessage('Suite loaded');
  };
  const save = () => {
    try {
      const parsed = AgentSuiteSchema.parse(JSON.parse(draft));
      upsert(parsed);
      setActiveId(parsed.id);
      setDraft(JSON.stringify(parsed, null, 2));
      setMessage('Saved and schema-validated');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };
  const exportSuite = () => {
    try {
      const parsed = AgentSuiteSchema.parse(JSON.parse(draft));
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(parsed, null, 2)], { type: 'application/json' })
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = `${parsed.id}.agent-suite.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };
  const importSuite = async (file: File) => {
    try {
      const parsed = AgentSuiteSchema.parse(JSON.parse(await file.text()));
      upsert(parsed);
      setActiveId(parsed.id);
      setDraft(JSON.stringify(parsed, null, 2));
      setMessage('Imported and schema-validated');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };
  const run = async () => {
    try {
      const parsed = AgentSuiteSchema.parse(JSON.parse(draft));
      upsert(parsed);
      setRunning(true);
      setMessage('Running agent trials…');
      const report = await runDesktopAgentSuite(parsed, providers, {
        requestApproval: async (request) =>
          window.confirm(
            `Allow ${request.permissionClass} tool “${request.toolName}”?\n\n${JSON.stringify(request.arguments, null, 2)}`
          )
            ? 'approved'
            : 'denied',
      });
      setMessage(
        `${report.status.toUpperCase()} · ${report.summary.passed}/${report.summary.total} passed · 95% CI ${(report.summary.confidence95.low * 100).toFixed(1)}–${(report.summary.confidence95.high * 100).toFixed(1)}%`
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setRunning(false);
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
          <Button size="sm" variant="outline" disabled={running} onClick={() => void run()}>
            {running ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Play className="mr-1.5 h-3.5 w-3.5" />
            )}
            Run
          </Button>
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
          {message}
        </div>
      </section>
    </div>
  );
}
