import { ArrowLeft, FlaskConical, Plug } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAiLabStore } from '../store/useAiLabStore';
import { useEvalRunStore } from '../store/useEvalRunStore';
import { Arena } from './Arena';
import { DatasetEditor } from './DatasetEditor';
import { EvalBuilder } from './EvalBuilder';
import { Playground } from './Playground';
import { ProviderManager } from './ProviderManager';
import { ReportView } from './ReportView';
import { Button } from '@/components/ui/button';
import { Floater, SubTabBar, SubTabPanel } from '@/components/ui/spatial';
import { isElectron, getPlatform } from '@/lib/shared/platform';

// CSS-in-JS region tag — Electron-only `WebkitAppRegion`. Mirrors TopBar so the
// AI Lab titlebar drags like the main window and interactive bits stay clickable.
const region = (value: 'drag' | 'no-drag'): React.CSSProperties =>
  ({ WebkitAppRegion: value }) as React.CSSProperties;

type AiLabTab = 'playground' | 'datasets' | 'evals' | 'arena' | 'reports' | 'providers';

const TAB_ORDER: readonly AiLabTab[] = [
  'playground',
  'datasets',
  'evals',
  'arena',
  'reports',
  'providers',
];

// Alt+1..6 jump straight to a tab (mirrors the HTTP RequestBuilder shortcut).
const TAB_KEYS: Record<string, AiLabTab> = {
  '1': 'playground',
  '2': 'datasets',
  '3': 'evals',
  '4': 'arena',
  '5': 'reports',
  '6': 'providers',
};

const TAB_LABELS: Record<AiLabTab, string> = {
  playground: 'Playground',
  datasets: 'Datasets',
  evals: 'Evals',
  arena: 'Arena',
  reports: 'Reports',
  providers: 'Providers',
};

/**
 * AI Lab — Electron-only workbench for testing prompts/models, running
 * dataset-driven evals (deterministic + script + LLM-as-judge scorers), and
 * comparing local (Ollama) vs cloud models. Reachable at /ai-lab; on web it
 * renders a desktop-only state.
 */
export default function AiLabWorkspace() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<AiLabTab>('playground');

  // Cheap length selectors drive the tab count badges + the first-run nudge.
  const datasetCount = useAiLabStore((s) => Object.keys(s.datasets).length);
  const providerCount = useAiLabStore((s) => Object.keys(s.providers).length);
  const runCount = useEvalRunStore((s) => Object.keys(s.runs).length);
  const hasDiscoveredModels = useAiLabStore((s) =>
    Object.values(s.providers).some((p) => p.models.length > 0)
  );

  const tabs = useMemo(() => {
    const counts: Partial<Record<AiLabTab, number>> = {
      datasets: datasetCount,
      reports: runCount,
      providers: providerCount,
    };
    return TAB_ORDER.map((value, i) => {
      const count = counts[value];
      // TAB_ORDER's index matches TAB_KEYS' Alt+1..6 digits 1:1.
      const title = `${TAB_LABELS[value]} (Alt+${i + 1})`;
      return count
        ? { value, label: TAB_LABELS[value], count, title }
        : { value, label: TAB_LABELS[value], title };
    });
  }, [datasetCount, runCount, providerCount]);

  // Alt+1..6 sub-tab jump (ignored while typing in an input/textarea).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.altKey && !e.metaKey && !e.ctrlKey) {
        const next = TAB_KEYS[e.key];
        if (next) {
          e.preventDefault();
          setTab(next);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // macOS Electron paints real traffic lights over the top-left at
  // trafficLightPosition (x:15). Reserve space so the back button clears them.
  const showTrafficLights = isElectron() && getPlatform() === 'darwin';

  // Brand-new users land on Playground with nothing configured; nudge them to
  // add a provider first, then — once a provider exists but nothing's been
  // discovered yet — to go discover its models. Without the second stage the
  // "zero → working eval" path stalled silently once a provider was added.
  const showOnboarding = (providerCount === 0 || !hasDiscoveredModels) && tab !== 'providers';

  return (
    <div className="flex h-screen flex-col text-sp-text">
      <header
        style={{ ...region('drag'), height: 44 }}
        className="flex shrink-0 select-none items-center gap-3 border-b border-sp-line bg-sp-surface px-3.5"
      >
        {showTrafficLights && (
          <span className="block shrink-0" style={{ width: 56 }} aria-hidden="true" />
        )}
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
        <span className="text-sp-12 text-sp-muted">
          Prompt &amp; model testing · evals · LLM-as-judge
        </span>
      </header>

      {!isElectron() ? (
        <DesktopOnly />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <SubTabBar<AiLabTab> tabs={tabs} value={tab} onChange={setTab} />
          {showOnboarding && (
            <Floater
              radius="panel"
              elevation="none"
              className="flex shrink-0 items-center gap-3 border-b border-sp-line bg-[var(--sp-accent-glow-15)] px-4 py-2.5"
            >
              <Plug className="h-4 w-4 shrink-0 text-sp-accent" />
              <p className="min-w-0 flex-1 text-sp-12 text-sp-text">
                {providerCount === 0
                  ? 'No model providers yet. Add Ollama or an OpenAI-compatible endpoint to start running prompts and evals.'
                  : 'You have a provider but no discovered models yet. Use “Discover models” on it to start running prompts and evals.'}
              </p>
              <Button
                variant="cta"
                size="sm"
                onClick={() => setTab('providers')}
                className="shrink-0"
              >
                {providerCount === 0 ? 'Add a provider' : 'Go to Providers'}
              </Button>
            </Floater>
          )}
          {/* Each tab owns its own full-height layout + scroll: master-detail
              panes fill the window; form/config tabs scroll within a readable
              measure. No outer max-width centering (which left dead margins). */}
          <SubTabPanel tabKey={tab} className="min-h-0 flex-1 overflow-hidden">
            {tab === 'playground' && <Playground />}
            {tab === 'datasets' && <DatasetEditor />}
            {tab === 'evals' && <EvalBuilder />}
            {tab === 'arena' && <Arena />}
            {tab === 'reports' && <ReportView />}
            {tab === 'providers' && <ProviderManager />}
          </SubTabPanel>
        </div>
      )}
    </div>
  );
}

function DesktopOnly() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <FlaskConical className="h-10 w-10 text-sp-dim" />
      <h2 className="text-lg font-semibold text-sp-text">AI Lab is a desktop-only feature</h2>
      <p className="max-w-md text-sp-13 text-sp-muted">
        Testing local LLMs (Ollama) and OpenAI-compatible endpoints requires direct network access
        the browser can&apos;t provide. Open Restura&apos;s desktop app to use the AI Lab.
      </p>
    </div>
  );
}
