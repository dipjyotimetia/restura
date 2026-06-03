import { useNavigate } from 'react-router-dom';
import { ArrowLeft, FlaskConical } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { isElectron } from '@/lib/shared/platform';
import { ProviderManager } from './ProviderManager';
import { Playground } from './Playground';
import { DatasetEditor } from './DatasetEditor';
import { EvalBuilder } from './EvalBuilder';
import { ReportView } from './ReportView';

/**
 * AI Lab — Electron-only workbench for testing prompts/models, running
 * dataset-driven evals (deterministic + script + LLM-as-judge scorers), and
 * comparing local (Ollama) vs cloud models. Reachable at /ai-lab; on web it
 * renders a desktop-only state.
 */
export default function AiLabWorkspace() {
  const navigate = useNavigate();

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex items-center gap-3 border-b border-border/50 px-4 py-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate('/')}
          aria-label="Back to workspace"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <FlaskConical className="h-4 w-4 text-primary" />
        <h1 className="text-sm font-semibold">AI Lab</h1>
        <span className="text-xs text-muted-foreground">
          Prompt &amp; model testing · evals · LLM-as-judge
        </span>
      </header>

      {!isElectron() ? (
        <DesktopOnly />
      ) : (
        <Tabs defaultValue="playground" className="flex min-h-0 flex-1 flex-col">
          <TabsList className="mx-4 mt-3 w-fit">
            <TabsTrigger value="playground">Playground</TabsTrigger>
            <TabsTrigger value="datasets">Datasets</TabsTrigger>
            <TabsTrigger value="evals">Evals</TabsTrigger>
            <TabsTrigger value="reports">Reports</TabsTrigger>
            <TabsTrigger value="providers">Providers</TabsTrigger>
          </TabsList>
          <div className="min-h-0 flex-1 overflow-auto p-4">
            <TabsContent value="playground" className="mt-0">
              <Playground />
            </TabsContent>
            <TabsContent value="datasets" className="mt-0">
              <DatasetEditor />
            </TabsContent>
            <TabsContent value="evals" className="mt-0">
              <EvalBuilder />
            </TabsContent>
            <TabsContent value="reports" className="mt-0">
              <ReportView />
            </TabsContent>
            <TabsContent value="providers" className="mt-0">
              <ProviderManager />
            </TabsContent>
          </div>
        </Tabs>
      )}
    </div>
  );
}

function DesktopOnly() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <FlaskConical className="h-10 w-10 text-muted-foreground" />
      <h2 className="text-lg font-semibold">AI Lab is a desktop-only feature</h2>
      <p className="max-w-md text-sm text-muted-foreground">
        Testing local LLMs (Ollama) and OpenAI-compatible endpoints requires direct network access
        the browser can&apos;t provide. Open Restura&apos;s desktop app to use the AI Lab.
      </p>
    </div>
  );
}
