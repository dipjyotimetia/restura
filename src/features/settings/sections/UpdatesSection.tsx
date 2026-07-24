import { Download, RefreshCw } from 'lucide-react';
import { useCallback, useState } from 'react';
import { DesktopOnlyBadge } from '@/components/shared/DesktopOnlyBadge';
import { Badge } from '@/components/ui/badge';
import { useReleaseNotes } from '@/components/shared/settings/useReleaseNotes';
import { Segmented, ToggleField } from '@/components/ui/spatial';
import { getElectronAPI, isElectron } from '@/lib/shared/platform';
import { parseReleaseNoteContent, type ReleaseNotesChannel } from '@/lib/shared/release-notes';
import { cn } from '@/lib/shared/utils';
import { useSettingsStore } from '@/store/useSettingsStore';
import { DEFAULT_AUTO_UPDATE_SETTINGS } from '@/types';
import { FieldGroup, FieldRow, SectionHeader } from '../components/SettingsSectionPrimitives';
import { formatReleaseDate, ReleaseNoteMarkdown } from './ShortcutsSection';

function ReleaseNotesPanel({ channel }: { channel: ReleaseNotesChannel }) {
  const {
    releases,
    selectedId,
    setSelectedId,
    nextPage,
    loading,
    loadingMore,
    error,
    reload,
    loadMore,
  } = useReleaseNotes(channel);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(() => new Set());

  const selected = releases.find((release) => release.id === selectedId) ?? releases[0];
  const content = selected ? parseReleaseNoteContent(selected.body) : null;

  return (
    <section className="mt-6" aria-labelledby="release-notes-heading">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 id="release-notes-heading" className="text-sp-14 font-semibold text-sp-text">
            Release notes
          </h3>
          <p className="mt-1 text-sp-12 text-sp-muted">
            Published release history from GitHub.{' '}
            {channel === 'beta' ? 'Beta releases included.' : 'Stable releases only.'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void reload(true)}
          disabled={loading}
          className={cn(
            'inline-flex items-center gap-1.5 h-8 px-3 rounded-sp-btn shrink-0',
            'bg-sp-surface border border-sp-line text-sp-text text-sp-12 font-medium',
            'hover:bg-sp-hover hover:border-sp-line-strong transition-colors',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent',
            'disabled:opacity-50 disabled:cursor-not-allowed'
          )}
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} aria-hidden />
          Refresh
        </button>
      </div>

      {loading && <p className="mt-4 text-sp-12 text-sp-muted">Loading release notes…</p>}

      {!loading && error && (
        <div className="mt-4 rounded-sp-btn border border-red-500/30 bg-red-500/10 p-3 text-sp-12 text-red-200">
          <p>{error}</p>
          <button
            type="button"
            onClick={() => void reload(true)}
            className="mt-2 font-medium underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent"
          >
            Try again
          </button>
        </div>
      )}

      {!loading && !error && releases.length === 0 && (
        <p className="mt-4 text-sp-12 text-sp-muted">
          No published release notes are available yet.
        </p>
      )}

      {!loading && !error && selected && (
        <div className="mt-4 grid min-h-56 grid-cols-[10.5rem_minmax(0,1fr)] overflow-hidden rounded-sp-btn border border-sp-line bg-sp-surface-lo">
          <div className="max-h-80 overflow-y-auto border-r border-sp-line p-1.5">
            {releases.map((release) => (
              <button
                key={release.id}
                type="button"
                aria-pressed={release.id === selected.id}
                onClick={() => setSelectedId(release.id)}
                className={cn(
                  'w-full rounded-sp-btn px-2.5 py-2 text-left transition-colors',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent',
                  release.id === selected.id
                    ? 'bg-sp-active text-sp-text'
                    : 'text-sp-muted hover:bg-sp-hover hover:text-sp-text'
                )}
              >
                <span className="block text-sp-12 font-semibold">{release.name}</span>
                <span className="mt-0.5 flex items-center gap-1 text-sp-11 text-sp-dim">
                  {formatReleaseDate(release.publishedAt)}
                  {release.isPrerelease && <Badge variant="secondary">Beta</Badge>}
                </span>
              </button>
            ))}
            {nextPage != null && (
              <button
                type="button"
                onClick={() => void loadMore()}
                disabled={loadingMore}
                className="mt-1 w-full rounded-sp-btn px-2.5 py-2 text-sp-11 font-medium text-sp-accent hover:bg-sp-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent disabled:opacity-50"
              >
                {loadingMore ? 'Loading…' : 'Load older releases'}
              </button>
            )}
          </div>
          <article className="max-h-80 overflow-y-auto p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h4 className="text-sp-14 font-semibold text-sp-text">{selected.name}</h4>
                <p className="mt-0.5 text-sp-11 text-sp-muted">{selected.tag}</p>
              </div>
              <a
                href={selected.url}
                target="_blank"
                rel="noreferrer noopener"
                aria-label={`Open ${selected.tag} on GitHub`}
                className="text-sp-11 font-medium text-sp-accent underline underline-offset-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent"
              >
                View on GitHub
              </a>
            </div>
            {selected.body ? (
              <div className="mt-4 space-y-4 text-sp-12 leading-5 text-sp-muted">
                {content?.preamble ? (
                  <div className="space-y-2 break-words [&_h1]:text-sp-14 [&_h1]:font-semibold [&_h2]:text-sp-13 [&_h2]:font-semibold [&_h3]:text-sp-12 [&_h3]:font-semibold [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5">
                    <ReleaseNoteMarkdown>{content.preamble}</ReleaseNoteMarkdown>
                  </div>
                ) : null}

                {content?.highlights ? (
                  <section
                    aria-labelledby="release-highlights-heading"
                    className="rounded-sp-btn border border-sp-accent/25 bg-sp-accent/8 p-3"
                  >
                    <h5
                      id="release-highlights-heading"
                      className="text-sp-12 font-semibold text-sp-text"
                    >
                      Highlights
                    </h5>
                    <div className="mt-2 [&_ul]:space-y-1.5 [&_ul]:pl-4 [&_ul]:marker:text-sp-accent [&_ul]:list-disc">
                      <ReleaseNoteMarkdown>{content.highlights}</ReleaseNoteMarkdown>
                    </div>
                  </section>
                ) : null}

                {content?.upgradeNotes ? (
                  <section
                    aria-labelledby="release-upgrade-notes-heading"
                    className="rounded-sp-btn border border-amber-500/25 bg-amber-500/8 p-3"
                  >
                    <h5
                      id="release-upgrade-notes-heading"
                      className="text-sp-12 font-semibold text-sp-text"
                    >
                      Upgrade notes
                    </h5>
                    <div className="mt-2 [&_ul]:space-y-1.5 [&_ul]:pl-4 [&_ul]:list-disc">
                      <ReleaseNoteMarkdown>{content.upgradeNotes}</ReleaseNoteMarkdown>
                    </div>
                  </section>
                ) : null}

                {content?.sections.map((section) => {
                  const expanded = expandedSections.has(section.title);
                  return (
                    <section key={section.title} className="rounded-sp-btn border border-sp-line">
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedSections((current) => {
                            const next = new Set(current);
                            if (next.has(section.title)) next.delete(section.title);
                            else next.add(section.title);
                            return next;
                          })
                        }
                        aria-expanded={expanded}
                        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sp-12 font-semibold text-sp-text hover:bg-sp-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent"
                      >
                        <span>{section.title}</span>
                        <span className="text-sp-11 font-medium text-sp-muted">
                          {section.itemCount} {section.itemCount === 1 ? 'change' : 'changes'}
                        </span>
                      </button>
                      {expanded ? (
                        <div className="border-t border-sp-line px-6 py-2.5 [&_ul]:space-y-1.5 [&_ul]:list-disc">
                          <ReleaseNoteMarkdown>{section.body}</ReleaseNoteMarkdown>
                        </div>
                      ) : null}
                    </section>
                  );
                })}

                {content?.contributors ? (
                  <p className="text-sp-11 text-sp-dim">
                    <ReleaseNoteMarkdown>{content.contributors}</ReleaseNoteMarkdown>
                  </p>
                ) : null}

                {content?.extraSections.map((section) => (
                  <section key={section.title} className="rounded-sp-btn border border-sp-line p-3">
                    <h5 className="text-sp-12 font-semibold text-sp-text">{section.title}</h5>
                    <div className="mt-2 [&_ul]:space-y-1.5 [&_ul]:pl-4 [&_ul]:list-disc">
                      <ReleaseNoteMarkdown>{section.body}</ReleaseNoteMarkdown>
                    </div>
                  </section>
                ))}

                {content?.fallbackBody ? (
                  <div className="space-y-2 break-words [&_h1]:text-sp-14 [&_h1]:font-semibold [&_h2]:text-sp-13 [&_h2]:font-semibold [&_h3]:text-sp-12 [&_h3]:font-semibold [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5">
                    <ReleaseNoteMarkdown>{content.fallbackBody}</ReleaseNoteMarkdown>
                  </div>
                ) : null}
              </div>
            ) : (
              <p className="mt-4 text-sp-12 text-sp-muted">
                No release notes were provided for this release.
              </p>
            )}
          </article>
        </div>
      )}
    </section>
  );
}

export function UpdatesSection() {
  const version = import.meta.env.VITE_APP_VERSION || '0.0.0';
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const autoUpdate = settings.autoUpdate ?? DEFAULT_AUTO_UPDATE_SETTINGS;

  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<string | null>(null);

  const handleCheck = useCallback(async () => {
    const api = getElectronAPI();
    if (!api) return;
    setChecking(true);
    setCheckResult(null);
    try {
      const res = await api.updater.check();
      if (res.error) setCheckResult(`Check failed: ${res.error}`);
      else if (res.updateAvailable)
        setCheckResult(`Update available${res.version ? ` — v${res.version}` : ''}`);
      else setCheckResult(res.message ?? "You're up to date");
    } finally {
      setChecking(false);
    }
  }, []);

  if (!isElectron()) {
    return (
      <>
        <SectionHeader
          icon={Download}
          title="Updates"
          description="Automatic updates for the Restura desktop app."
        />
        <FieldGroup label="Updates">
          <FieldRow
            label="Current version"
            hint="The web app always serves the latest version — no manual update needed."
            control={<span className="text-sp-13 font-mono text-sp-muted">v{version}</span>}
          />
          <FieldRow
            label="Desktop auto-update"
            hint="Background updates are available in the Restura desktop app."
            control={<DesktopOnlyBadge title="Auto-update is an Electron desktop feature." />}
          />
        </FieldGroup>
        <ReleaseNotesPanel channel="stable" />
      </>
    );
  }

  return (
    <>
      <SectionHeader
        icon={Download}
        title="Updates"
        description="Keep Restura up to date automatically, or check on demand."
      />

      <FieldGroup label="Automatic updates">
        <FieldRow
          label="Download updates automatically"
          hint="When on, new versions download in the background and prompt you to restart."
          control={
            <ToggleField
              checked={autoUpdate.autoDownload}
              onChange={(v) => updateSettings({ autoUpdate: { ...autoUpdate, autoDownload: v } })}
              ariaLabel="Download updates automatically"
            />
          }
        />
        <FieldRow
          label="Release channel"
          hint="Stable is recommended. Beta receives pre-releases earlier."
          control={
            <Segmented<'stable' | 'beta'>
              value={autoUpdate.channel}
              onChange={(v) => updateSettings({ autoUpdate: { ...autoUpdate, channel: v } })}
              options={[
                { value: 'stable', label: 'Stable' },
                { value: 'beta', label: 'Beta' },
              ]}
            />
          }
        />
      </FieldGroup>

      <FieldGroup label="Check">
        <FieldRow
          label="Current version"
          control={<span className="text-sp-13 font-mono text-sp-muted">v{version}</span>}
        />
        <FieldRow
          label="Check for updates"
          hint={checkResult ?? 'Fetch the latest release from GitHub.'}
          control={
            <button
              type="button"
              onClick={() => void handleCheck()}
              disabled={checking}
              className={cn(
                'inline-flex items-center gap-1.5 h-8 px-3 rounded-sp-btn shrink-0',
                'bg-sp-surface border border-sp-line text-sp-text text-sp-12 font-medium',
                'hover:bg-sp-hover hover:border-sp-line-strong transition-colors',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent',
                'disabled:opacity-50 disabled:cursor-not-allowed'
              )}
            >
              <RefreshCw size={13} className={checking ? 'animate-spin' : ''} aria-hidden />
              <span>{checking ? 'Checking…' : 'Check now'}</span>
            </button>
          }
        />
      </FieldGroup>
      <ReleaseNotesPanel channel={autoUpdate.channel} />
    </>
  );
}
