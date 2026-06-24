import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as yaml from 'js-yaml';
import { X, Upload, CheckCircle2, AlertCircle, Lock, Download, Check } from 'lucide-react';
import { useState, type ChangeEvent, type DragEvent } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Floater } from '@/components/ui/spatial';
import {
  importPostmanCollection,
  importPostmanEnvironment,
  isPostmanEnvironment,
  importInsomniaCollection,
  importOpenAPICollection,
  importOpenCollection,
  importHoppscotchCollection,
  importHoppscotchEnvironment,
  isHoppscotchEnvironment,
  importBrunoCollection,
  validateImportedCollection,
  type ImportResult,
  type ImportWarning,
} from '@/features/collections/lib/importers';
import { isElectron } from '@/lib/shared/platform';
import { convertCollectionSecretsToHandles } from '@/lib/shared/secretRef-migrations';
import { cn } from '@/lib/shared/utils';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';

type ImportType = 'postman' | 'insomnia' | 'openapi' | 'opencollection' | 'hoppscotch' | 'bruno';

interface FormatMeta {
  id: ImportType;
  name: string;
  tagline: string;
  initials: string;
  /** Brand-ish color used only for the letter badge. Active selection still
   *  goes through the accent variable so themes stay coherent. */
  color: string;
  accept: string;
}

const FORMATS: FormatMeta[] = [
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
    accept: '.bru',
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
    'Auth (Basic, Bearer, API Key, Digest, OAuth2, OAuth1, NTLM, WSSE, AWS SigV4)',
    'Pre-request, test scripts, assertions',
    'Pre-request and post-response variables',
  ],
};

const IMPORTERS: Record<ImportType, (data: unknown) => Promise<ImportResult>> = {
  postman: async (data) => {
    const warnings: ImportWarning[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
};

function describeWarning(w: ImportWarning): string {
  switch (w.kind) {
    case 'unrecognized-body':
      return `Unknown body shape in "${w.requestName}" — preserved on round-trip but not editable`;
    case 'unrecognized-script-type':
      return `Script type "${w.scriptType}" dropped from "${w.requestName}"`;
    case 'unsupported-auth':
      return `Auth "${w.authType}" not supported in "${w.requestName}"`;
    case 'unsupported-method':
      return `Method "${w.method}" not supported — "${w.requestName}" imported as GET`;
    case 'unknown-dynamic-var':
      return `{{$${w.varName}}} referenced ${w.count}× but not implemented`;
    case 'bruno-syntax':
      return `Bruno-specific syntax "${w.pattern}" in "${w.requestName}"`;
    case 'platform-unsupported':
      return `${w.feature} not available on this platform (${w.requestName})`;
    case 'schema-version':
      return `${w.format} v${w.version}: ${w.note}`;
    default:
      return 'Unknown warning';
  }
}

interface FormatCardProps {
  format: FormatMeta;
  active: boolean;
  onClick: () => void;
}

function FormatCard({ format, active, onClick }: FormatCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'relative flex items-center gap-2.5 p-3 rounded-sp-btn text-left',
        'border transition-all duration-150',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent',
        active
          ? 'border-sp-accent bg-sp-active'
          : 'border-sp-line bg-sp-surface-lo hover:bg-sp-hover hover:border-sp-line-strong'
      )}
      style={
        active
          ? { boxShadow: '0 0 0 1px var(--sp-accent), 0 8px 20px var(--sp-accent-glow-33)' }
          : undefined
      }
    >
      <span
        aria-hidden="true"
        className="flex items-center justify-center size-9 rounded-sp-btn shrink-0 text-sp-11 font-bold text-white tracking-wide"
        style={{
          background: format.color,
          boxShadow: `0 4px 10px ${format.color}55, inset 0 1px 0 rgba(255,255,255,0.2)`,
        }}
      >
        {format.initials}
      </span>
      <span className="flex flex-col min-w-0 flex-1">
        <span className="text-sp-13 font-semibold text-sp-text leading-tight">{format.name}</span>
        <span className="text-sp-11 text-sp-muted leading-tight mt-0.5 truncate">
          {format.tagline}
        </span>
      </span>
      {active && <Check size={14} className="text-sp-accent shrink-0" aria-hidden="true" />}
    </button>
  );
}

interface DropZoneProps {
  format: FormatMeta;
  onFileUpload: (event: ChangeEvent<HTMLInputElement>) => void;
  onDrop: (event: DragEvent<HTMLDivElement>) => void;
}

function DropZone({ format, onFileUpload, onDrop }: DropZoneProps) {
  const [isDragging, setIsDragging] = useState(false);

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- drop zone for drag-and-drop only; keyboard/pointer access is provided by the file input + label inside
    <div
      onDrop={(e) => {
        setIsDragging(false);
        onDrop(e);
      }}
      onDragOver={(e) => {
        e.preventDefault();
        if (!isDragging) setIsDragging(true);
      }}
      onDragLeave={(e) => {
        // `dragLeave` fires on the parent whenever the cursor crosses into a
        // child element (icon, heading, "Choose file" button). Only flip
        // the state when the cursor actually leaves the drop zone itself.
        const next = e.relatedTarget;
        if (next instanceof Node && e.currentTarget.contains(next)) return;
        setIsDragging(false);
      }}
      className={cn(
        'relative rounded-sp-panel border-2 border-dashed p-8',
        'transition-all duration-150',
        isDragging
          ? 'border-sp-accent bg-sp-active'
          : 'border-sp-line bg-sp-surface-lo hover:border-sp-line-strong hover:bg-sp-hover'
      )}
      style={isDragging ? { boxShadow: '0 0 0 4px var(--sp-accent-glow-33)' } : undefined}
    >
      <div
        aria-hidden="true"
        className="absolute inset-0 pointer-events-none rounded-sp-panel"
        style={{
          background: isDragging
            ? 'radial-gradient(circle at 50% 0%, var(--sp-accent-glow-33), transparent 70%)'
            : undefined,
        }}
      />
      <input
        type="file"
        accept={format.accept}
        onChange={onFileUpload}
        aria-label={`Choose ${format.name} file`}
        className="hidden"
        id={`file-upload-${format.id}`}
      />
      <label
        htmlFor={`file-upload-${format.id}`}
        className="relative flex flex-col items-center gap-3 cursor-pointer text-center"
      >
        <div
          className="flex items-center justify-center size-14 rounded-full"
          style={{
            background: 'var(--sp-surface)',
            border: '1px solid var(--sp-line)',
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)',
          }}
        >
          <Download
            size={22}
            className={cn('transition-colors', isDragging ? 'text-sp-accent' : 'text-sp-muted')}
          />
        </div>
        <div>
          <p className="text-sp-14 font-semibold text-sp-text">
            {isDragging ? `Release to import ${format.name}` : `Drop your ${format.name} file here`}
          </p>
          <p className="text-sp-12 text-sp-muted mt-0.5">
            or click to browse · accepts{' '}
            <code className="font-mono text-sp-11-5 text-sp-text/80">{format.accept}</code>
          </p>
        </div>
        <span
          className={cn(
            'inline-flex items-center gap-1.5 h-8 px-3 rounded-sp-btn pointer-events-none',
            'bg-sp-surface border border-sp-line-strong text-sp-text text-sp-12 font-medium',
            'shadow-sm'
          )}
        >
          <Upload size={12} aria-hidden="true" />
          Choose file
        </span>
      </label>
    </div>
  );
}

interface ImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function ImportDialog({ open, onOpenChange }: ImportDialogProps) {
  const { addCollection } = useCollectionStore();
  const { addEnvironment } = useEnvironmentStore();
  const [importStatus, setImportStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [warnings, setWarnings] = useState<ImportResult['warnings']>([]);
  const [activeFormat, setActiveFormat] = useState<ImportType>('postman');
  const [environmentOnlyName, setEnvironmentOnlyName] = useState<string | null>(null);
  const [storeSecretsAsHandles, setStoreSecretsAsHandles] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');

  const format = FORMATS.find((f) => f.id === activeFormat) ?? FORMATS[0]!;
  const features = FEATURE_LISTS[activeFormat];

  const parseFileContent = (text: string, fileName: string): unknown => {
    if (fileName.endsWith('.yaml') || fileName.endsWith('.yml')) {
      return yaml.load(text);
    }
    if (fileName.endsWith('.bru')) {
      return text;
    }
    return JSON.parse(text);
  };

  /** Pasted text has no filename to sniff — try JSON first, then YAML. */
  const parsePastedContent = (text: string, type: ImportType): unknown => {
    if (type === 'bruno') return text;
    try {
      return JSON.parse(text);
    } catch {
      return yaml.load(text);
    }
  };

  type ProcessOutcome = ImportResult | { kind: 'environment-only'; environmentName: string };

  const processImportData = async (data: unknown, type: ImportType): Promise<ProcessOutcome> => {
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
    const text = await file.text();
    return processImportData(parseFileContent(text, file.name), type);
  };

  const handleImportSuccess = async (outcome: ProcessOutcome) => {
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
            <StatusBanner
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

            {/* Format grid */}
            <section>
              <div className="sp-label mb-2">Choose a source</div>
              <div className="grid grid-cols-3 gap-2.5">
                {FORMATS.map((f) => (
                  <FormatCard
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
              <DropZone format={format} onFileUpload={handleFileUpload} onDrop={handleDrop} />
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

interface StatusBannerProps {
  status: 'idle' | 'success' | 'error';
  warnings: ImportWarning[];
  environmentOnlyName: string | null;
  errorMessage: string;
  onDismiss: () => void;
}

function StatusBanner({
  status,
  warnings,
  environmentOnlyName,
  errorMessage,
  onDismiss,
}: StatusBannerProps) {
  if (status === 'idle') return null;

  if (status === 'success' && warnings.length === 0) {
    return (
      <Floater
        radius="panel"
        elevation="inset"
        className="p-3.5 flex items-center gap-2.5 border border-emerald-500/30"
        style={{ background: 'rgba(16,185,129,0.08)' }}
      >
        <CheckCircle2 size={16} className="text-emerald-400 shrink-0" />
        <span className="text-sp-13 text-emerald-300 font-medium">
          {environmentOnlyName
            ? `Imported environment: ${environmentOnlyName}`
            : 'Collection imported successfully'}
        </span>
      </Floater>
    );
  }

  if (status === 'success' && warnings.length > 0) {
    return (
      <Floater
        radius="panel"
        elevation="inset"
        className="p-3.5 border border-amber-500/30"
        style={{ background: 'rgba(245,158,11,0.08)' }}
      >
        <div className="flex items-center justify-between gap-3 mb-2">
          <div className="flex items-center gap-2 text-amber-300 font-medium text-sp-13">
            <AlertCircle size={16} className="shrink-0" />
            <span>
              Imported with {warnings.length} warning{warnings.length === 1 ? '' : 's'}
            </span>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            className={cn(
              'inline-flex items-center h-7 px-3 rounded-sp-btn',
              'bg-sp-surface border border-sp-line text-sp-text text-sp-11 font-medium',
              'hover:bg-sp-hover transition-colors'
            )}
          >
            Dismiss
          </button>
        </div>
        <ul className="space-y-1 text-sp-12 text-sp-muted max-h-40 overflow-y-auto pr-1">
          {warnings.slice(0, 20).map((w, i) => (
            <li key={i} className="flex gap-2">
              <span className="text-amber-400/70 shrink-0">›</span>
              <span>{describeWarning(w)}</span>
            </li>
          ))}
          {warnings.length > 20 && (
            <li className="text-sp-muted italic">… and {warnings.length - 20} more</li>
          )}
        </ul>
      </Floater>
    );
  }

  // error
  return (
    <Floater
      radius="panel"
      elevation="inset"
      className="p-3.5 flex items-start gap-2.5 border border-rose-500/30"
      style={{ background: 'rgba(244,63,94,0.08)' }}
    >
      <AlertCircle size={16} className="text-rose-400 shrink-0 mt-0.5" />
      <div className="min-w-0">
        <div className="text-sp-13 text-rose-300 font-medium">Import failed</div>
        <p className="text-sp-12 text-rose-300/80 mt-0.5 break-words">{errorMessage}</p>
      </div>
    </Floater>
  );
}
