import { ArrowLeft, FlaskConical } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Arena } from './Arena';
import { DatasetEditor } from './DatasetEditor';
import { EvalBuilder } from './EvalBuilder';
import { Playground } from './Playground';
import { ProviderManager } from './ProviderManager';
import { ReportView } from './ReportView';
import { Button } from '@/components/ui/button';
import { SubTabBar } from '@/components/ui/spatial';
import { isElectron, getPlatform } from '@/lib/shared/platform';

// CSS-in-JS region tag — Electron-only `WebkitAppRegion`. Mirrors TopBar so the
// AI Lab titlebar drags like the main window and interactive bits stay clickable.
const region = (value: 'drag' | 'no-drag'): React.CSSProperties =>
  ({ WebkitAppRegion: value }) as React.CSSProperties;

type AiLabTab = 'playground' | 'datasets' | 'evals' | 'arena' | 'reports' | 'providers';

const TABS: ReadonlyArray<{ value: AiLabTab; label: string }> = [
  { value: 'playground', label: 'Playground' },
  { value: 'datasets', label: 'Datasets' },
  { value: 'evals', label: 'Evals' },
  { value: 'arena', label: 'Arena' },
  { value: 'reports', label: 'Reports' },
  { value: 'providers', label: 'Providers' },
];

/**
 * AI Lab — Electron-only workbench for testing prompts/models, running
 * dataset-driven evals (deterministic + script + LLM-as-judge scorers), and
 * comparing local (Ollama) vs cloud models. Reachable at /ai-lab; on web it
 * renders a desktop-only state.
 */
export default function AiLabWorkspace() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<AiLabTab>('playground');

  // macOS Electron paints real traffic lights over the top-left at
  // trafficLightPosition (x:15). Reserve space so the back button clears them.
  const showTrafficLights = isElectron() && getPlatform() === 'darwin';

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
          <SubTabBar<AiLabTab> tabs={TABS} value={tab} onChange={setTab} />
          {/* Each tab owns its own full-height layout + scroll: master-detail
              panes fill the window; form/config tabs scroll within a readable
              measure. No outer max-width centering (which left dead margins). */}
          <div className="min-h-0 flex-1 overflow-hidden">
            {tab === 'playground' && <Playground />}
            {tab === 'datasets' && <DatasetEditor />}
            {tab === 'evals' && <EvalBuilder />}
            {tab === 'arena' && <Arena />}
            {tab === 'reports' && <ReportView />}
            {tab === 'providers' && <ProviderManager />}
          </div>
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
