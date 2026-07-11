import {
  ArrowLeft,
  BarChart3,
  Bot,
  Database,
  FlaskConical,
  Gauge,
  PlaySquare,
  Trophy,
} from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAiLabStore } from '../store/useAiLabStore';
import { useAiLabUiStore, type AiLabTab } from '../store/useAiLabUiStore';
import { useArenaStore } from '../store/useArenaStore';
import { useEvalRunStore } from '../store/useEvalRunStore';
import { Arena } from './Arena';
import { DatasetEditor } from './DatasetEditor';
import { EvalBuilder } from './EvalBuilder';
import { Playground } from './Playground';
import { ProviderManager } from './ProviderManager';
import { ReportView } from './ReportView';
import { Button } from '@/components/ui/button';
import { getPlatform, isElectron } from '@/lib/shared/platform';
import { cn } from '@/lib/shared/utils';

const region = (value: 'drag' | 'no-drag'): React.CSSProperties =>
  ({ WebkitAppRegion: value }) as React.CSSProperties;

const NAV_ITEMS: Array<{
  value: AiLabTab;
  label: string;
  description: string;
  icon: typeof FlaskConical;
}> = [
  { value: 'playground', label: 'Playground', description: 'Compare prompts', icon: PlaySquare },
  { value: 'datasets', label: 'Datasets', description: 'Manage test cases', icon: Database },
  { value: 'evals', label: 'Evals', description: 'Score model runs', icon: Gauge },
  { value: 'arena', label: 'Arena', description: 'Rank head to head', icon: Trophy },
  { value: 'reports', label: 'Reports', description: 'Inspect results', icon: BarChart3 },
  { value: 'providers', label: 'Models', description: 'Connections & catalog', icon: Bot },
];

const TAB_KEYS: Record<string, AiLabTab> = {
  '1': 'playground',
  '2': 'datasets',
  '3': 'evals',
  '4': 'arena',
  '5': 'reports',
  '6': 'providers',
};

export default function AiLabWorkspace() {
  const navigate = useNavigate();
  const tab = useAiLabUiStore((state) => state.tab);
  const setTab = useAiLabUiStore((state) => state.setTab);
  const providers = useAiLabStore((state) => state.providers);
  const datasetCount = useAiLabStore((state) => Object.keys(state.datasets).length);
  const evalRuns = useEvalRunStore((state) => state.runs);
  const arenaRuns = useArenaStore((state) => state.runs);

  const providerCount = Object.keys(providers).length;
  const modelCount = useMemo(
    () => Object.values(providers).reduce((count, provider) => count + provider.models.length, 0),
    [providers]
  );
  const runCount = Object.keys(evalRuns).length + Object.keys(arenaRuns).length;
  const current = NAV_ITEMS.find((item) => item.value === tab) ?? NAV_ITEMS[0]!;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)
        return;
      if (event.altKey && !event.metaKey && !event.ctrlKey) {
        const next = TAB_KEYS[event.key];
        if (next) {
          event.preventDefault();
          setTab(next);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [setTab]);

  const showTrafficLights = isElectron() && getPlatform() === 'darwin';

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-sp-bg text-sp-text">
      <header
        style={{ ...region('drag'), height: 44 }}
        className="flex shrink-0 select-none items-center gap-3 border-b border-sp-line bg-sp-surface px-3.5"
      >
        {showTrafficLights && <span className="block w-14 shrink-0" aria-hidden />}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate('/')}
          aria-label="Back to workspace"
          style={region('no-drag')}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <FlaskConical className="h-4 w-4 text-sp-accent" />
        <h1 className="text-sp-14 font-semibold">AI Lab</h1>
        <span className="hidden text-sp-11 text-sp-muted min-[900px]:inline">
          Prompt and model evaluation workspace
        </span>

        {isElectron() && (
          <div className="ml-auto flex items-center gap-1.5" style={region('no-drag')}>
            <ReadinessButton
              label={
                providerCount
                  ? `${providerCount} ${providerCount === 1 ? 'provider' : 'providers'}`
                  : 'No providers'
              }
              ready={providerCount > 0}
              onClick={() => setTab('providers')}
            />
            <ReadinessButton
              label={
                modelCount ? `${modelCount} ${modelCount === 1 ? 'model' : 'models'}` : 'No models'
              }
              ready={modelCount > 0}
              onClick={() => setTab('providers')}
            />
            <ReadinessButton
              label={runCount ? `${runCount} ${runCount === 1 ? 'run' : 'runs'}` : 'No runs'}
              ready={runCount > 0}
              onClick={() => setTab('reports')}
            />
          </div>
        )}
      </header>

      {!isElectron() ? (
        <DesktopOnly />
      ) : (
        <div className="flex min-h-0 flex-1">
          <nav
            aria-label="AI Lab sections"
            className="flex w-44 shrink-0 flex-col border-r border-sp-line bg-sp-surface-lo p-2 max-[1000px]:w-14"
          >
            <div className="mb-2 px-2 pt-1 text-sp-9 font-semibold uppercase tracking-sp-label text-sp-dim max-[1000px]:sr-only">
              Workbench
            </div>
            <div className="space-y-1">
              {NAV_ITEMS.map((item, index) => {
                const Icon = item.icon;
                const active = item.value === tab;
                const count =
                  item.value === 'datasets'
                    ? datasetCount
                    : item.value === 'reports'
                      ? runCount
                      : item.value === 'providers'
                        ? modelCount
                        : 0;
                return (
                  <button
                    key={item.value}
                    type="button"
                    aria-label={item.label}
                    aria-current={active ? 'page' : undefined}
                    title={`${item.label} · ${item.description} (Alt+${index + 1})`}
                    onClick={() => setTab(item.value)}
                    className={cn(
                      'group relative flex w-full items-center gap-2.5 rounded-sp-btn px-2.5 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent/50 max-[1000px]:justify-center max-[1000px]:px-2',
                      active
                        ? 'bg-sp-active text-sp-text shadow-sp-inset'
                        : 'text-sp-muted hover:bg-sp-hover hover:text-sp-text'
                    )}
                  >
                    {active && (
                      <span className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-sp-accent" />
                    )}
                    <Icon className={cn('h-4 w-4 shrink-0', active && 'text-sp-accent')} />
                    <span className="min-w-0 flex-1 max-[1000px]:hidden">
                      <span className="block truncate text-sp-12 font-medium">{item.label}</span>
                      <span className="block truncate text-sp-9 text-sp-dim">
                        {item.description}
                      </span>
                    </span>
                    {count > 0 && (
                      <span className="rounded-full bg-sp-surface-hi px-1.5 py-0.5 text-sp-9 tabular-nums text-sp-muted max-[1000px]:hidden">
                        {count}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            <div className="mt-auto border-t border-sp-line px-2 pt-2 max-[1000px]:hidden">
              <div className="text-sp-9 font-semibold uppercase tracking-sp-label text-sp-dim">
                Now viewing
              </div>
              <div className="mt-1 text-sp-11 font-medium text-sp-text">{current.label}</div>
              <div className="text-sp-9 text-sp-muted">{current.description}</div>
            </div>
          </nav>

          <main
            className="min-h-0 min-w-0 flex-1 overflow-hidden"
            aria-label={`${current.label} workspace`}
          >
            <div key={tab} className="h-full animate-sp-panel-in">
              {tab === 'playground' && <Playground />}
              {tab === 'datasets' && <DatasetEditor />}
              {tab === 'evals' && <EvalBuilder />}
              {tab === 'arena' && <Arena />}
              {tab === 'reports' && <ReportView />}
              {tab === 'providers' && <ProviderManager />}
            </div>
          </main>
        </div>
      )}
    </div>
  );
}

function ReadinessButton({
  label,
  ready,
  onClick,
}: {
  label: string;
  ready: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1.5 rounded-full border border-sp-line bg-sp-surface-lo px-2 py-1 text-sp-9 text-sp-muted hover:border-sp-line-strong hover:text-sp-text"
    >
      <span
        className={cn('h-1.5 w-1.5 rounded-full', ready ? 'bg-emerald-500' : 'bg-sp-dim')}
        aria-hidden
      />
      {label}
    </button>
  );
}

function DesktopOnly() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <FlaskConical className="h-10 w-10 text-sp-dim" />
      <h2 className="text-lg font-semibold text-sp-text">AI Lab is a desktop-only feature</h2>
      <p className="max-w-md text-sp-13 text-sp-muted">
        Testing local LLMs and keychain-backed providers requires Restura&apos;s desktop app.
      </p>
    </div>
  );
}
