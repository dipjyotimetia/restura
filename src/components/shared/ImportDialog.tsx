import * as DialogPrimitive from '@radix-ui/react-dialog';
import type { DeepLinkImportFormat } from '@shared/deep-link';
import * as yaml from 'js-yaml';
import { Check, Download, Lock, Upload, X } from 'lucide-react';
import { type ChangeEvent, type DragEvent, useEffect, useState } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Floater } from '@/components/ui/spatial';
import {
  buildHarImportCollections,
  type HarImportPreview,
  type ImportResult,
  type ImportWarning,
  importBrunoCollection,
  importHoppscotchCollection,
  importHoppscotchEnvironment,
  importHttpFile,
  importInsomniaCollection,
  importOpenAPICollection,
  importOpenCollection,
  importPostmanCollection,
  importPostmanEnvironment,
  isHoppscotchEnvironment,
  isPostmanEnvironment,
  parseHarImport,
  validateImportedCollection,
} from '@/features/collections/lib/importers';
import { getElectronAPI, isElectron } from '@/lib/shared/platform';
import { convertCollectionSecretsToHandles } from '@/lib/shared/secretRef-migrations';
import { cn } from '@/lib/shared/utils';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { HarImportReview } from './HarImportReview';
import { ImportDropZone, ImportFormatCard, type ImportFormatMeta } from './ImportFormatPicker';
import { ImportStatusBanner } from './ImportStatusBanner';

type ImportType =
  | 'postman'
  | 'insomnia'
  | 'openapi'
  | 'opencollection'
  | 'hoppscotch'
  | 'bruno'
  | 'http'
  | 'har';

const FORMATS: Array<ImportFormatMeta & { id: ImportType }> = [
  {
    id: 'postman',
    name: 'Postman',
    tagline: 'v2.1 collections & environments',
    initials: 'PM',
    color: '#ff6c37',
    accept: '.json,.yaml,.yml',
  },
  {
    id: 'insomnia',
    name: 'Insomnia',
    tagline: 'v4 & v5 workspaces',
    initials: 'IN',
    color: '#7e5cef',
    accept: '.json,.yaml,.yml',
  },
  {
    id: 'openapi',
    name: 'OpenAPI',
    tagline: 'OpenAPI 3.x · Swagger 2.0',
    initials: 'OA',
    color: '#6ba539',
    accept: '.json,.yaml,.yml',
  },
  {
    id: 'opencollection',
    name: 'OpenCollection',
    tagline: 'Bruno 3.1+ bundled format',
    initials: 'OC',
    color: '#2e91ff',
    accept: '.json,.yaml,.yml',
  },
  {
    id: 'hoppscotch',
    name: 'Hoppscotch',
    tagline: 'Collections & environments',
    initials: 'HP',
    color: '#22c55e',
    accept: '.json,.yaml,.yml',
  },
  {
    id: 'bruno',
    name: 'Bruno',
    tagline: 'Legacy .bru text DSL',
    initials: 'BR',
    color: '#f06b00',
    accept: '.bru,.zip',
  },
  {
    id: 'http',
    name: '.http File',
    tagline: 'VS Code REST Client · JetBrains HTTP Client',
    initials: 'HT',
    color: '#0ea5e9',
    accept: '.http,.rest',
  },
  {
    id: 'har',
    name: 'HAR',
    tagline: 'HTTP Archive 1.2 browser captures',
    initials: 'HR',
    color: '#f59e0b',
    accept: '.har,.json',
  },
];

const FEATURE_LISTS: Record<ImportType, string[]> = {
  postman: [
    'Collections and folders',
    'HTTP requests (all methods)',
    'Query parameters and headers',
    'Request body (JSON, form-data, etc.)',
    'Auth (Basic, Bearer, API Key, OAuth2, AWS Sig)',
    'Pre-request and test scripts',
    'Environment variables',
  ],
  insomnia: [
    'Workspaces and request groups',
    'HTTP requests',
    'Headers and parameters',
    'Request body',
    'Auth (Basic, Bearer, API Key, OAuth2)',
  ],
  openapi: [
    'OpenAPI 3.x and Swagger 2.0',
    'Paths and operations (all methods)',
    'Query, header, and path parameters',
    'Request bodies with example generation',
    'Tag-based folder organisation',
    'Security schemes',
    'Server URL configuration',
  ],
  opencollection: [
    'OpenCollection v1.0.0 (Bruno 3.1+)',
    'HTTP, gRPC, GraphQL, WebSocket',
    'SSE and MCP via x-restura-* extensions',
    'Auth (Basic, Bearer, API Key, Digest, OAuth2, AWS SigV4)',
    'Environment + secret variables',
    'Folder hierarchy & metadata',
  ],
  hoppscotch: [
    'Hoppscotch JSON exports',
    'Folders with full hierarchy',
    'Pre-request & test scripts',
    'Auth (Basic, Bearer, API Key, OAuth2, AWS SigV4, Digest)',
    'Environment variables with secret flag',
    'pw.* / hopp.* script aliases',
  ],
  bruno: [
    'Bruno legacy .bru files (text DSL)',
    'For Bruno 3.1+, use OpenCollection',
    'Single .bru: drop or paste the file',
    'Multi-file workspace: drop a .zip export',
    'Auth (Basic, Bearer, API Key, Digest, OAuth2, OAuth1, NTLM, WSSE, AWS SigV4)',
    'Pre-request, test scripts, assertions',
    'Pre-request and post-response variables',
  ],
  http: [
    '### request separators, one request per block',
    '@name and file-level @var declarations',
    'Headers and raw body, {{var}} passthrough',
    'Query params parsed from the request URL',
    'JetBrains < {% %} / > {% %} scripts (stored, not executed)',
    'VS Code {{$guid}} / {{$timestamp}} dynamic vars flagged as unsupported',
  ],
  har: [
    'HAR 1.2 browser capture entries',
    'Page-first grouping with origin fallback',
    'Methods, URLs, queries, headers, and request bodies',
    'Entry review and selection before persistence',
    'Authorization and token redaction before preview',
    'Cookies and captured response bodies discarded',
  ],
};

const IMPORTERS: Record<Exclude<ImportType, 'har'>, (data: unknown) => Promise<ImportResult>> = {
  postman: async (data) => {
    const warnings: ImportWarning[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: legacy type boundary
    const collection = await importPostmanCollection(data as any, warnings);
    return { collection, warnings };
  },
  insomnia: async (data) => importInsomniaCollection(data),
  openapi: async (data) => {
    const warnings: ImportWarning[] = [];
    const collection = await importOpenAPICollection(data, warnings);
    return { collection, warnings };
  },
  opencollection: async (data) => importOpenCollection(data),
  hoppscotch: async (data) => importHoppscotchCollection(data),
  bruno: async (data) =>
    importBrunoCollection({
      kind: 'single',
      content: typeof data === 'string' ? data : JSON.stringify(data),
    }),
  http: async (data) => importHttpFile(typeof data === 'string' ? data : String(data)),
};

interface ImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A deep link is deliberately review-only until the user confirms download. */
  deepLinkSource?: { url: string; format?: DeepLinkImportFormat };
}

export default function ImportDialog({ open, onOpenChange, deepLinkSource }: ImportDialogProps) {
  const addCollection = useCollectionStore((s) => s.addCollection);
  const addEnvironment = useEnvironmentStore((s) => s.addEnvironment);
  const [importStatus, setImportStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [warnings, setWarnings] = useState<ImportResult['warnings']>([]);
  const [activeFormat, setActiveFormat] = useState<ImportType>('postman');
  const [environmentOnlyName, setEnvironmentOnlyName] = useState<string | null>(null);
  const [storeSecretsAsHandles, setStoreSecretsAsHandles] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [harPreview, setHarPreview] = useState<HarImportPreview | null>(null);
  const [selectedHarEntries, setSelectedHarEntries] = useState<Set<string>>(new Set());
  const [selectedHarEnvironments, setSelectedHarEnvironments] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (deepLinkSource?.format) setActiveFormat(deepLinkSource.format);
  }, [deepLinkSource]);

  const format = FORMATS.find((f) => f.id === activeFormat) ?? FORMATS[0]!;
  const features = FEATURE_LISTS[activeFormat];

  const parseFileContent = (text: string, fileName: string): unknown => {
    if (fileName.endsWith('.yaml') || fileName.endsWith('.yml')) {
      return yaml.load(text);
    }
    if (
      fileName.endsWith('.bru') ||
      fileName.endsWith('.http') ||
      fileName.endsWith('.rest') ||
      fileName.endsWith('.har')
    ) {
      return text;
    }
    return JSON.parse(text);
  };

  /** Pasted text has no filename to sniff — try JSON first, then YAML. */
  const parsePastedContent = (text: string, type: ImportType): unknown => {
    if (type === 'bruno' || type === 'http' || type === 'har') return text;
    try {
      return JSON.parse(text);
    } catch {
      return yaml.load(text);
    }
  };

  type ProcessOutcome =
    | ImportResult
    | { kind: 'environment-only'; environmentName: string }
    | { kind: 'har-preview'; preview: HarImportPreview };

  const processImportData = async (data: unknown, type: ImportType): Promise<ProcessOutcome> => {
    if (type === 'har') {
      if (typeof data !== 'string') throw new Error('HAR input must be JSON text');
      return { kind: 'har-preview', preview: parseHarImport(data) };
    }
    if (type === 'postman' && isPostmanEnvironment(data)) {
      const env = importPostmanEnvironment(data);
      addEnvironment(env);
      return { kind: 'environment-only', environmentName: env.name };
    }
    if (type === 'hoppscotch' && isHoppscotchEnvironment(data)) {
      const env = importHoppscotchEnvironment(data);
      addEnvironment(env);
      return { kind: 'environment-only', environmentName: env.name };
    }
    return IMPORTERS[type](data);
  };

  const processImportFile = async (file: File, type: ImportType): Promise<ProcessOutcome> => {
    if (type === 'har') return processImportData(await file.text(), type);
    if (type === 'http') {
      const text = await file.text();
      return importHttpFile(text, { fileName: file.name });
    }
    if (type === 'bruno' && file.name.toLowerCase().endsWith('.zip')) {
      const { unzipToEntries } = await import('@/lib/shared/zip-utils');
      const entries = await unzipToEntries(new Uint8Array(await file.arrayBuffer()));
      return importBrunoCollection({ kind: 'directory', entries });
    }
    const text = await file.text();
    return processImportData(parseFileContent(text, file.name), type);
  };

  const handleImportSuccess = async (outcome: ProcessOutcome) => {
    if ('kind' in outcome && outcome.kind === 'har-preview') {
      setHarPreview(outcome.preview);
      setSelectedHarEntries(
        new Set(
          outcome.preview.groups.flatMap((group) =>
            group.entries.filter((entry) => entry.selected).map((entry) => entry.id)
          )
        )
      );
      setSelectedHarEnvironments(new Set());
      setWarnings(outcome.preview.warnings);
      setImportStatus('idle');
      return;
    }
    if ('kind' in outcome) {
      setImportStatus('success');
      setWarnings((prev) => (prev.length === 0 ? prev : []));
      setEnvironmentOnlyName(outcome.environmentName);
      setTimeout(() => {
        onOpenChange(false);
        setImportStatus('idle');
        setEnvironmentOnlyName(null);
      }, 1500);
      return;
    }
    // Gate the converter's output through the same Zod schema the store
    // validators use — importer bugs surface here instead of corrupting
    // persisted state. Reject-only: the original object (with passthrough
    // bags like OpenCollection's `_oc`) is what gets stored.
    const validation = validateImportedCollection(outcome.collection);
    if (!validation.ok) {
      handleImportError(
        new Error(`Imported collection failed validation — ${validation.issues.join('; ')}`)
      );
      return;
    }
    const collection =
      storeSecretsAsHandles && isElectron()
        ? await convertCollectionSecretsToHandles(outcome.collection)
        : outcome.collection;
    addCollection(collection);
    for (const env of outcome.environments ?? []) {
      addEnvironment(env);
    }
    setImportStatus('success');
    setWarnings(outcome.warnings);
    setEnvironmentOnlyName(null);
    if (outcome.warnings.length === 0) {
      setTimeout(() => {
        onOpenChange(false);
        setImportStatus('idle');
      }, 1500);
    }
  };

  const handleConfirmHarImport = async () => {
    if (!harPreview) return;
    try {
      const results = buildHarImportCollections(
        harPreview,
        selectedHarEntries,
        selectedHarEnvironments
      );
      if (results.length === 0) throw new Error('Select at least one HAR entry to import');
      for (const result of results) {
        const validation = validateImportedCollection(result.collection);
        if (!validation.ok) {
          throw new Error(
            `Imported collection failed validation — ${validation.issues.join('; ')}`
          );
        }
        addCollection(result.collection);
        for (const environment of result.environments ?? []) addEnvironment(environment);
      }
      setWarnings(harPreview.warnings);
      setHarPreview(null);
      setImportStatus('success');
    } catch (error) {
      handleImportError(error);
    }
  };

  const toggleHarEntry = (entryId: string) => {
    setSelectedHarEntries((current) => {
      const next = new Set(current);
      if (next.has(entryId)) next.delete(entryId);
      else next.add(entryId);
      return next;
    });
  };

  const toggleHarEnvironment = (candidateId: string) => {
    setSelectedHarEnvironments((current) => {
      const next = new Set(current);
      if (next.has(candidateId)) next.delete(candidateId);
      else next.add(candidateId);
      return next;
    });
  };

  const handleImportError = (error: unknown) => {
    setImportStatus('error');
    const message = error instanceof Error ? error.message : 'Failed to import collection';
    setErrorMessage(message);
    setTimeout(() => setImportStatus('idle'), 3000);
  };

  const handleFileUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const outcome = await processImportFile(file, activeFormat);
      await handleImportSuccess(outcome);
    } catch (error: unknown) {
      handleImportError(error);
    }
    event.target.value = '';
  };

  const handleDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const file = event.dataTransfer.files?.[0];
    if (!file) return;
    try {
      const outcome = await processImportFile(file, activeFormat);
      await handleImportSuccess(outcome);
    } catch (error: unknown) {
      handleImportError(error);
    }
  };

  const handlePasteImport = async () => {
    if (!pasteText.trim()) return;
    try {
      const data = parsePastedContent(pasteText, activeFormat);
      const outcome = await processImportData(data, activeFormat);
      await handleImportSuccess(outcome);
      setPasteText('');
      setPasteOpen(false);
    } catch (error: unknown) {
      handleImportError(error);
    }
  };

  const handleDeepLinkImport = async () => {
    if (!deepLinkSource) return;
    const api = getElectronAPI();
    if (!api?.deepLinks) return;
    try {
      const downloaded = await api.deepLinks.fetchImport(deepLinkSource.url);
      if (!downloaded.ok) throw new Error(downloaded.error);
      const outcome = await processImportData(
        parsePastedContent(downloaded.text, activeFormat),
        activeFormat
      );
      await handleImportSuccess(outcome);
    } catch (error) {
      handleImportError(error);
    }
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            'fixed inset-0 z-50',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0'
          )}
          style={{
            background: 'rgba(0,0,0,0.55)',
            backdropFilter: 'blur(6px)',
            WebkitBackdropFilter: 'blur(6px)',
          }}
        />
        <DialogPrimitive.Content
          aria-label="Import collection"
          className={cn(
            'fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2',
            'w-[860px] max-w-[calc(100vw-32px)] max-h-[calc(100vh-32px)]',
            'flex flex-col rounded-sp-window border border-sp-line-strong outline-none',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
            'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95'
          )}
          style={{
            background: 'var(--sp-surface-hi)',
            boxShadow: '0 30px 80px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.04)',
          }}
        >
          <DialogPrimitive.Title className="sr-only">Import collection</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Import requests and environments from another API client
          </DialogPrimitive.Description>

          {/* Header */}
          <div className="flex items-start justify-between gap-4 px-6 pt-5 pb-4 border-b border-sp-line shrink-0">
            <div className="flex items-start gap-3">
              <div
                aria-hidden="true"
                className="shrink-0 flex items-center justify-center size-10 rounded-sp-btn border border-sp-line"
                style={{
                  background:
                    'linear-gradient(135deg, var(--sp-accent-glow-33), transparent 70%), var(--sp-surface-lo)',
                  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06)',
                }}
              >
                <Download size={18} className="text-sp-accent" />
              </div>
              <div className="flex flex-col leading-tight">
                <h1 className="text-sp-16 font-bold text-sp-text">Import collection</h1>
                <p className="text-sp-12-5 text-sp-muted mt-0.5">
                  Bring requests, environments, and scripts from another API client.
                </p>
              </div>
            </div>
            <DialogPrimitive.Close
              aria-label="Close import dialog"
              className={cn(
                'inline-flex items-center justify-center w-9 h-9 rounded-sp-btn shrink-0',
                'bg-sp-surface-lo border border-sp-line text-sp-muted',
                'hover:text-sp-text hover:bg-sp-hover hover:border-sp-line-strong',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent',
                'transition-colors'
              )}
            >
              <X size={14} />
            </DialogPrimitive.Close>
          </div>

          {/* Body */}
          <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 space-y-5">
            <ImportStatusBanner
              status={importStatus}
              warnings={warnings}
              environmentOnlyName={environmentOnlyName}
              errorMessage={errorMessage}
              onDismiss={() => {
                onOpenChange(false);
                setImportStatus('idle');
                setWarnings([]);
              }}
            />

            {deepLinkSource && (
              <section className="rounded-sp-btn border border-sp-line bg-sp-surface-lo p-4">
                <div className="sp-label">Review deep-link import</div>
                <p className="mt-1 break-all text-sp-12 text-sp-muted">{deepLinkSource.url}</p>
                <p className="mt-2 text-sp-12 text-sp-muted">
                  This source has not been downloaded. Choose a format below, then confirm the
                  import.
                </p>
                <button
                  type="button"
                  onClick={() => void handleDeepLinkImport()}
                  className="mt-3 rounded-sp-btn bg-sp-accent px-3 py-2 text-sp-12 font-semibold text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent"
                >
                  Download and import
                </button>
              </section>
            )}

            {harPreview ? (
              <HarImportReview
                preview={harPreview}
                selectedEntries={selectedHarEntries}
                selectedEnvironments={selectedHarEnvironments}
                onSelectAll={() =>
                  setSelectedHarEntries(
                    new Set(
                      harPreview.groups.flatMap((group) => group.entries.map((entry) => entry.id))
                    )
                  )
                }
                onSelectNone={() => setSelectedHarEntries(new Set())}
                onToggleEntry={toggleHarEntry}
                onToggleEnvironment={toggleHarEnvironment}
                onChooseAnotherFile={() => {
                  setHarPreview(null);
                  setSelectedHarEntries(new Set());
                  setSelectedHarEnvironments(new Set());
                }}
                onConfirm={() => void handleConfirmHarImport()}
              />
            ) : (
              <>
                {/* Format grid */}
                <section>
                  <div className="sp-label mb-2">Choose a source</div>
                  <div className="grid grid-cols-3 gap-2.5">
                    {FORMATS.map((f) => (
                      <ImportFormatCard
                        key={f.id}
                        format={f}
                        active={f.id === activeFormat}
                        onClick={() => setActiveFormat(f.id)}
                      />
                    ))}
                  </div>
                </section>

                {/* Drop zone */}
                <section>
                  <ImportDropZone
                    format={format}
                    onFileUpload={handleFileUpload}
                    onDrop={handleDrop}
                  />
                  <div className="mt-2">
                    <button
                      type="button"
                      onClick={() => setPasteOpen((v) => !v)}
                      className="text-sp-12 text-sp-muted hover:text-sp-text transition-colors underline underline-offset-2"
                    >
                      {pasteOpen ? 'Hide paste area' : 'Or paste the file contents instead'}
                    </button>
                    {pasteOpen && (
                      <div className="mt-2 space-y-2">
                        <textarea
                          value={pasteText}
                          onChange={(e) => setPasteText(e.target.value)}
                          placeholder={
                            activeFormat === 'bruno'
                              ? 'Paste .bru file contents…'
                              : activeFormat === 'http'
                                ? 'Paste .http file contents…'
                                : `Paste ${format.name} JSON or YAML…`
                          }
                          aria-label="Paste import content"
                          spellCheck={false}
                          className={cn(
                            'w-full h-36 p-3 rounded-sp-btn resize-y',
                            'bg-sp-surface-lo border border-sp-line text-sp-text text-sp-12 font-mono',
                            'placeholder:text-sp-muted/70',
                            'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent'
                          )}
                        />
                        <button
                          type="button"
                          onClick={handlePasteImport}
                          disabled={!pasteText.trim()}
                          className={cn(
                            'inline-flex items-center gap-1.5 h-8 px-4 rounded-sp-btn',
                            'bg-sp-surface border border-sp-line-strong text-sp-text text-sp-12 font-medium',
                            'hover:bg-sp-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
                            'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent'
                          )}
                        >
                          <Upload size={12} aria-hidden="true" />
                          Import pasted {format.name}
                        </button>
                      </div>
                    )}
                  </div>
                </section>
              </>
            )}

            {/* Supported features */}
            <section>
              <div className="sp-label mb-2">What gets imported</div>
              <Floater radius="panel" elevation="inset" className="p-4">
                <ul className="grid grid-cols-2 gap-x-5 gap-y-2">
                  {features.map((feature) => (
                    <li key={feature} className="flex items-start gap-2 text-sp-12-5 text-sp-text">
                      <span
                        aria-hidden="true"
                        className="flex items-center justify-center size-4 rounded-full shrink-0 mt-0.5"
                        style={{
                          background: 'var(--sp-accent-glow-33)',
                          color: 'var(--sp-accent)',
                        }}
                      >
                        <Check size={10} strokeWidth={3} />
                      </span>
                      <span className="leading-snug">{feature}</span>
                    </li>
                  ))}
                </ul>
              </Floater>
            </section>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between gap-4 px-6 py-4 border-t border-sp-line shrink-0">
            {isElectron() ? (
              <label
                htmlFor="import-store-secrets-as-handles"
                className="inline-flex items-center gap-2 cursor-pointer"
              >
                <Checkbox
                  id="import-store-secrets-as-handles"
                  checked={storeSecretsAsHandles}
                  onCheckedChange={(checked) => setStoreSecretsAsHandles(checked === true)}
                />
                <span className="inline-flex items-center gap-1.5 text-sp-12 text-sp-muted">
                  <Lock size={12} aria-hidden="true" />
                  Store imported secrets in the OS keychain
                </span>
              </label>
            ) : (
              <span />
            )}
            <DialogPrimitive.Close
              className={cn(
                'inline-flex items-center justify-center h-8 px-4 rounded-sp-btn',
                'bg-sp-surface border border-sp-line text-sp-text text-sp-12 font-medium',
                'hover:bg-sp-hover hover:border-sp-line-strong transition-colors',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent'
              )}
            >
              Close
            </DialogPrimitive.Close>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
