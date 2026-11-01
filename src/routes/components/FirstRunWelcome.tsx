import { BookOpen, Download, FolderOpen, Lock, Play, Sparkles } from 'lucide-react';
import { DesktopOnlyBadge } from '@/components/shared/DesktopOnlyBadge';
import { Button } from '@/components/ui/button';
import { Floater, ProtoChip } from '@/components/ui/spatial';
import { ToggleField } from '@/components/ui/spatial/ToggleField';
import { addSampleCollection } from '@/features/collections/lib/addSampleCollection';
import { ECHO_URLS } from '@/lib/shared/echo-defaults';
import { isElectron, openExternalUrl } from '@/lib/shared/platform';
import { useSettingsStore } from '@/store/useSettingsStore';
import type { RequestMode } from '@/types';
import { NEW_REQUEST_PROTOCOLS } from './NoOpenTabs';

/** The request the live demo sends — a plain GET to the echo server. */
export const DEMO_REQUEST_URL = `${ECHO_URLS.http}?hello=restura`;

const RELEASES_URL = 'https://github.com/dipjyotimetia/restura/releases/latest';
const QUICK_START_URL = 'https://docs.restura.dev/overview/quick-start/';

interface FirstRunWelcomeProps {
  /** Load the demo request into a tab and send it through the real executor. */
  onRunDemo: () => void;
  onNewRequest: (mode: RequestMode) => void;
  onOpenImport: () => void;
  onTakeTour: () => void;
  /** Leave the welcome screen without doing anything else. */
  onDismiss: () => void;
}

/**
 * First-run workspace for the web app: replaces the blank request tab and the
 * modal tour with one screen that shows Restura working (live demo), offers
 * the three ways to start, and carries the crash-report opt-out the tour's
 * privacy step used to own.
 */
export function FirstRunWelcome({
  onRunDemo,
  onNewRequest,
  onOpenImport,
  onTakeTour,
  onDismiss,
}: FirstRunWelcomeProps) {
  const desktop = isElectron();
  const telemetryEnabled = useSettingsStore((s) => s.settings.telemetry?.errorsEnabled ?? true);
  const updateSettings = useSettingsStore((s) => s.updateSettings);

  return (
    <Floater
      radius="panel"
      elevation="float-lg"
      className="@container flex-1 m-2 overflow-y-auto"
      data-testid="first-run-welcome"
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-7 px-5 py-8 @xl:px-10 @xl:py-10">
        <header className="space-y-3">
          <p className="font-mono text-sp-11 uppercase tracking-[0.08em] text-sp-accent">
            Welcome · no account needed
          </p>
          <h1 className="text-2xl font-semibold tracking-tight text-sp-text @xl:text-3xl">
            Send your first request in one click.
          </h1>
          <p className="max-w-xl text-sp-13 leading-relaxed text-sp-muted">
            HTTP, GraphQL, gRPC, WebSocket, Socket.IO, SSE and MCP, all from this tab. Collections,
            history and secrets stay on this device.
          </p>
        </header>

        <section
          aria-label="Live demo"
          className="overflow-hidden rounded-sp-panel border border-sp-line bg-sp-surface-hi"
        >
          <div className="flex flex-wrap items-center gap-2.5 p-3">
            <div className="flex min-w-0 flex-1 basis-80 items-center gap-2.5 rounded-sp-btn border border-sp-line bg-sp-surface-lo px-3 py-2.5 font-mono text-sp-12">
              <span className="font-medium text-emerald-500 dark:text-emerald-400">GET</span>
              <span className="truncate text-sp-text" title={DEMO_REQUEST_URL}>
                {DEMO_REQUEST_URL}
              </span>
            </div>
            <Button variant="glow" size="lg" className="gap-2" onClick={onRunDemo}>
              <Play className="h-4 w-4" aria-hidden="true" />
              Run live demo
            </Button>
          </div>
          <p className="border-t border-sp-line px-4 py-3 text-sp-12 text-sp-muted">
            A real request to the echo server. Nothing to configure — the response opens in the
            workspace.
          </p>
        </section>

        {/* Container query, not viewport: the sidebar and AI panel eat width. */}
        <div className="grid gap-3 @2xl:grid-cols-3">
          <button
            type="button"
            onClick={() => {
              addSampleCollection();
              onDismiss();
            }}
            className="flex flex-col gap-2 rounded-sp-panel border border-sp-line bg-sp-surface-hi p-4 text-left transition-colors hover:border-sp-line-strong hover:bg-sp-hover-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent"
          >
            <Sparkles className="h-5 w-5 text-violet-400" aria-hidden="true" />
            <span className="text-sp-13 font-medium text-sp-text">Open the sample collection</span>
            <span className="text-sp-12 leading-relaxed text-sp-muted">
              Ready-to-run HTTP, GraphQL, gRPC and SSE requests against the echo server.
            </span>
          </button>
          <button
            type="button"
            onClick={onOpenImport}
            className="flex flex-col gap-2 rounded-sp-panel border border-sp-line bg-sp-surface-hi p-4 text-left transition-colors hover:border-sp-line-strong hover:bg-sp-hover-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent"
          >
            <FolderOpen className="h-5 w-5 text-amber-400" aria-hidden="true" />
            <span className="text-sp-13 font-medium text-sp-text">Bring your collections</span>
            <span className="text-sp-12 leading-relaxed text-sp-muted">
              Import from Postman, Insomnia, OpenAPI or Bruno — or drop a file anywhere.
            </span>
          </button>
          <div className="flex flex-col gap-2.5 rounded-sp-panel border border-sp-line bg-sp-surface-hi p-4">
            <span className="text-sp-13 font-medium text-sp-text">Start blank</span>
            <ul className="flex flex-wrap gap-1.5" aria-label="New request">
              {NEW_REQUEST_PROTOCOLS.map((p) => (
                <li key={p.mode}>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1.5 px-2"
                    disabled={p.desktopOnly && !desktop}
                    onClick={() => onNewRequest(p.mode)}
                    aria-label={`New ${p.label} request`}
                  >
                    <ProtoChip protocol={p.chip} />
                    {p.desktopOnly && !desktop && <DesktopOnlyBadge />}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <footer className="flex flex-col gap-4 border-t border-sp-line pt-5 text-sp-12 text-sp-muted">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="flex items-center gap-2">
              <Lock className="h-4 w-4 shrink-0 text-emerald-500" aria-hidden="true" />
              {desktop
                ? 'Stored on this computer. No sign-up, no cloud sync.'
                : 'Stored in this browser. No sign-up, no cloud sync.'}
            </span>
            <span className="flex items-center gap-2">
              Send crash &amp; error reports
              <ToggleField
                size="sm"
                checked={telemetryEnabled}
                onChange={(v) => updateSettings({ telemetry: { errorsEnabled: v } })}
                ariaLabel="Send crash and error reports"
              />
            </span>
          </div>
          <p className="leading-relaxed">
            Reports carry only the error, stack, app version and browser/OS — never your requests,
            URLs, headers or response bodies. Change it anytime in Settings → Privacy.
          </p>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <Button variant="ghost" size="sm" className="px-0" onClick={onTakeTour}>
              Take the tour
            </Button>
            <a
              href={QUICK_START_URL}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => {
                // Desktop opens docs in the system browser, not the app window.
                e.preventDefault();
                void openExternalUrl(QUICK_START_URL);
              }}
              className="inline-flex items-center gap-1.5 text-sp-accent hover:underline"
            >
              <BookOpen className="h-3.5 w-3.5" aria-hidden="true" />
              Read the docs
            </a>
            {!desktop && (
              <a
                href={RELEASES_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-sp-accent hover:underline"
              >
                <Download className="h-3.5 w-3.5" aria-hidden="true" />
                Get the desktop app
              </a>
            )}
            <Button variant="ghost" size="sm" className="ml-auto" onClick={onDismiss}>
              Skip to workspace
            </Button>
          </div>
        </footer>
      </div>
    </Floater>
  );
}
