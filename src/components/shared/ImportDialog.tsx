import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
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
  type ImportResult,
  type ImportWarning,
} from '@/features/collections/lib/importers';
import { FileJson, Upload, CheckCircle, AlertCircle } from 'lucide-react';
import YAML from 'yaml';

type ImportType = 'postman' | 'insomnia' | 'openapi' | 'opencollection' | 'hoppscotch' | 'bruno';

const TYPE_LABELS: Record<ImportType, string> = {
  postman: 'Postman',
  insomnia: 'Insomnia',
  openapi: 'OpenAPI / Swagger',
  opencollection: 'OpenCollection',
  hoppscotch: 'Hoppscotch',
  bruno: 'Bruno',
};

/**
 * Every importer returns the unified ImportResult shape. Legacy importers
 * (postman, openapi) that still return a bare Collection get adapted here
 * with empty warnings. Insomnia and OpenCollection return ImportResult
 * directly — multi-environment + script extraction surface through that path.
 */
const IMPORTERS: Record<ImportType, (data: unknown) => Promise<ImportResult>> = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  postman: async (data) => ({ collection: await importPostmanCollection(data as any), warnings: [] }),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  insomnia: async (data) => importInsomniaCollection(data as any),
  openapi: async (data) => ({ collection: await importOpenAPICollection(data), warnings: [] }),
  opencollection: async (data) => importOpenCollection(data),
  hoppscotch: async (data) => importHoppscotchCollection(data),
  bruno: async (data) => importBrunoCollection({ kind: 'single', content: typeof data === 'string' ? data : JSON.stringify(data) }),
};

const FEATURE_LISTS: Record<ImportType, string[]> = {
  postman: [
    'Collections and folders',
    'HTTP requests (all methods)',
    'Query parameters and headers',
    'Request body (JSON, form-data, etc.)',
    'Authentication (Basic, Bearer, API Key, OAuth2, AWS Signature)',
    'Pre-request and test scripts',
    'Environment variables',
  ],
  insomnia: [
    'Workspaces and request groups',
    'HTTP requests',
    'Headers and parameters',
    'Request body',
    'Authentication (Basic, Bearer, API Key, OAuth2)',
  ],
  openapi: [
    'OpenAPI 3.x and Swagger 2.0 specifications',
    'Paths and operations (all HTTP methods)',
    'Query, header, and path parameters',
    'Request bodies with example generation',
    'Tag-based folder organization',
    'Security schemes (Basic, Bearer, API Key, OAuth2)',
    'Server URL configuration',
  ],
  opencollection: [
    'OpenCollection v1.0.0 (compatible with Bruno 3.1+)',
    'HTTP, gRPC, GraphQL, WebSocket requests',
    'SSE and MCP via x-restura-* extensions',
    'Authentication (Basic, Bearer, API Key, Digest, OAuth2, AWS SigV4)',
    'Environment variables and secret variables',
    'Folder hierarchy and request metadata',
    'Bundled (single file) format',
  ],
  hoppscotch: [
    'Hoppscotch JSON exports (collections + environments)',
    'Folders and nested requests with full hierarchy',
    'Pre-request and test scripts (collection AND request level)',
    'Authentication (Basic, Bearer, API Key, OAuth2, AWS SigV4, Digest)',
    'Environment variables with secret flag',
    'pw.* and hopp.* script API aliases (mapped to pm.*)',
  ],
  bruno: [
    'Bruno legacy .bru files (text DSL)',
    'For Bruno 3.1+ collections, use the OpenCollection tab instead',
    'Single .bru file: drop or paste the file contents',
    'Authentication (Basic, Bearer, API Key, Digest, OAuth2, OAuth1, NTLM, WSSE, AWS SigV4)',
    'Pre-request scripts, test scripts, and assertions',
    'Variables: pre-request and post-response',
    'Bruno-specific syntax ({{process.env.X}}, response chaining) emits warnings',
  ],
};

interface DropZoneProps {
  type: ImportType;
  onFileUpload: (event: React.ChangeEvent<HTMLInputElement>, type: ImportType) => void;
  onDrop: (event: React.DragEvent<HTMLDivElement>, type: ImportType) => void;
}

function DropZone({ type, onFileUpload, onDrop }: DropZoneProps) {
  return (
    <div
      onDrop={(e) => onDrop(e, type)}
      onDragOver={(e) => e.preventDefault()}
      className="border border-dashed border-border rounded-lg p-10 text-center hover:border-primary/50 hover:bg-foreground/5 transition-colors cursor-pointer"
    >
      <input
        type="file"
        accept={type === 'bruno' ? '.bru' : '.json,.yaml,.yml'}
        onChange={(e) => onFileUpload(e, type)}
        className="hidden"
        id={`file-upload-${type}`}
      />
      <label htmlFor={`file-upload-${type}`} className="cursor-pointer block">
        <div className="flex flex-col items-center gap-3">
          <FileJson className="h-10 w-10 text-muted-foreground/40" />
          <div>
            <p className="text-sm font-mono text-muted-foreground">
              Drop {TYPE_LABELS[type]} collection here
            </p>
            <p className="text-xs text-muted-foreground/50 font-mono mt-1">or click to browse</p>
          </div>
          <Button variant="outline" size="sm" type="button" className="font-mono text-xs pointer-events-none">
            <Upload className="mr-2 h-3.5 w-3.5" />
            Choose File
          </Button>
        </div>
      </label>
    </div>
  );
}

function describeWarning(w: ImportWarning): string {
  switch (w.kind) {
    case 'unrecognized-body':
      return `Unknown body shape in "${w.requestName}" — preserved on round-trip but not editable`;
    case 'unrecognized-script-type':
      return `Script type "${w.scriptType}" dropped from "${w.requestName}"`;
    case 'unsupported-auth':
      return `Auth "${w.authType}" not supported in "${w.requestName}"`;
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
  const [activeTab, setActiveTab] = useState<ImportType>('postman');
  // Set when the user dropped a Postman environment file (not a collection).
  // Surfaces a tailored success label so the user knows nothing went wrong
  // even though no collection appeared.
  const [environmentOnlyName, setEnvironmentOnlyName] = useState<string | null>(null);

  const parseFileContent = (text: string, fileName: string): unknown => {
    if (fileName.endsWith('.yaml') || fileName.endsWith('.yml')) {
      return YAML.parse(text);
    }
    if (fileName.endsWith('.bru')) {
      // Bruno files are not JSON or YAML — return raw text; the importer parses it.
      return text;
    }
    return JSON.parse(text);
  };

  /**
   * `processImportFile` returns either a normal ImportResult or a special
   * `{ kind: 'environment-only', name }` marker when the dropped file is a
   * Postman or Hoppscotch environment export. The marker lets the success
   * handler skip the addCollection() call and surface a tailored success
   * message.
   */
  type ProcessOutcome = ImportResult | { kind: 'environment-only'; environmentName: string };

  const processImportFile = async (file: File, type: ImportType): Promise<ProcessOutcome> => {
    const text = await file.text();
    const data = parseFileContent(text, file.name);
    // Postman environment files are auto-detected regardless of selected tab —
    // they look nothing like a collection, so the inferred behaviour is safe.
    if (type === 'postman' && isPostmanEnvironment(data)) {
      const env = importPostmanEnvironment(data);
      addEnvironment(env);
      return { kind: 'environment-only', environmentName: env.name };
    }
    // Hoppscotch environment files: same auto-detect pattern.
    if (type === 'hoppscotch' && isHoppscotchEnvironment(data)) {
      const env = importHoppscotchEnvironment(data);
      addEnvironment(env);
      return { kind: 'environment-only', environmentName: env.name };
    }
    // Bruno: parseFileContent passes .bru text through unparsed; the IMPORTERS
    // entry wraps it in BrunoSource. No special case needed here.
    return IMPORTERS[type](data);
  };

  const handleImportSuccess = (outcome: ProcessOutcome) => {
    if ('kind' in outcome) {
      setImportStatus('success');
      // Skip the [] -> [] re-render if warnings was already empty.
      setWarnings((prev) => (prev.length === 0 ? prev : []));
      setEnvironmentOnlyName(outcome.environmentName);
      setTimeout(() => {
        onOpenChange(false);
        setImportStatus('idle');
        setEnvironmentOnlyName(null);
      }, 1500);
      return;
    }
    addCollection(outcome.collection);
    for (const env of outcome.environments ?? []) {
      addEnvironment(env);
    }
    setImportStatus('success');
    setWarnings(outcome.warnings);
    setEnvironmentOnlyName(null);
    if (outcome.warnings.length === 0) {
      // No issues — auto-close after the success flash
      setTimeout(() => {
        onOpenChange(false);
        setImportStatus('idle');
      }, 1500);
    }
    // With warnings: stay open until user dismisses
  };

  const handleImportError = (error: unknown) => {
    setImportStatus('error');
    const message = error instanceof Error ? error.message : 'Failed to import collection';
    setErrorMessage(message);
    setTimeout(() => setImportStatus('idle'), 3000);
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>, type: ImportType) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const outcome = await processImportFile(file, type);
      handleImportSuccess(outcome);
    } catch (error: unknown) {
      handleImportError(error);
    }

    event.target.value = '';
  };

  const handleDrop = async (event: React.DragEvent<HTMLDivElement>, type: ImportType) => {
    event.preventDefault();
    const file = event.dataTransfer.files?.[0];
    if (!file) return;

    try {
      const outcome = await processImportFile(file, type);
      handleImportSuccess(outcome);
    } catch (error: unknown) {
      handleImportError(error);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm tracking-wide">IMPORT COLLECTION</DialogTitle>
          <DialogDescription className="font-mono text-xs">
            Import from Postman, Insomnia, OpenAPI/Swagger, OpenCollection, Hoppscotch, or Bruno
          </DialogDescription>
        </DialogHeader>

        {importStatus === 'success' && warnings.length === 0 && (
          <div className="flex items-center gap-2 p-3 bg-emerald-500/10 border border-emerald-500/20 rounded text-emerald-400 text-xs font-mono">
            <CheckCircle className="h-4 w-4 shrink-0" />
            <span>
              {environmentOnlyName
                ? `Imported environment: ${environmentOnlyName}`
                : 'Collection imported successfully!'}
            </span>
          </div>
        )}

        {importStatus === 'success' && warnings.length > 0 && (
          <div className="space-y-2 p-3 bg-amber-500/10 border border-amber-500/20 rounded text-xs font-mono">
            <div className="flex items-center gap-2 text-amber-400">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span className="font-medium">Imported with {warnings.length} warning{warnings.length === 1 ? '' : 's'}</span>
            </div>
            <ul className="space-y-1 text-muted-foreground max-h-40 overflow-y-auto">
              {warnings.slice(0, 20).map((w: ImportWarning, i: number) => (
                <li key={i} className="flex gap-2">
                  <span className="text-amber-400/60">›</span>
                  <span>{describeWarning(w)}</span>
                </li>
              ))}
              {warnings.length > 20 && (
                <li className="text-muted-foreground/60 italic">… and {warnings.length - 20} more</li>
              )}
            </ul>
            <div className="flex gap-2 pt-1">
              <Button
                variant="outline"
                size="sm"
                className="font-mono text-xs"
                onClick={() => {
                  onOpenChange(false);
                  setImportStatus('idle');
                  setWarnings([]);
                }}
              >
                Dismiss
              </Button>
            </div>
          </div>
        )}

        {importStatus === 'error' && (
          <div className="flex items-start gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded text-destructive text-xs font-mono">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <div>
              <span className="font-medium">Import failed</span>
              <p className="mt-1 opacity-80">{errorMessage}</p>
            </div>
          </div>
        )}

        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as ImportType)} className="w-full">
          <TabsList className="w-full justify-start border-b border-border rounded-none h-9 bg-transparent p-0">
            <TabsTrigger
              value="postman"
              className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none h-9 px-4 font-mono text-xs"
            >
              Postman
            </TabsTrigger>
            <TabsTrigger
              value="insomnia"
              className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none h-9 px-4 font-mono text-xs"
            >
              Insomnia
            </TabsTrigger>
            <TabsTrigger
              value="openapi"
              className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none h-9 px-4 font-mono text-xs"
            >
              OpenAPI
            </TabsTrigger>
            <TabsTrigger
              value="opencollection"
              className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none h-9 px-4 font-mono text-xs"
            >
              OpenCollection
            </TabsTrigger>
            <TabsTrigger
              value="hoppscotch"
              className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none h-9 px-4 font-mono text-xs"
            >
              Hoppscotch
            </TabsTrigger>
            <TabsTrigger
              value="bruno"
              className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none h-9 px-4 font-mono text-xs"
            >
              Bruno
            </TabsTrigger>
          </TabsList>

          {(['postman', 'insomnia', 'openapi', 'opencollection', 'hoppscotch', 'bruno'] as const).map((type) => (
            <TabsContent key={type} value={type} className="space-y-4 mt-4">
              <DropZone type={type} onFileUpload={handleFileUpload} onDrop={handleDrop} />
              <div className="space-y-1.5">
                <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                  Supported Features
                </p>
                <ul className="space-y-1">
                  {FEATURE_LISTS[type].map((feature) => (
                    <li key={feature} className="text-xs font-mono text-muted-foreground flex items-center gap-2">
                      <span className="text-primary/40">›</span>
                      {feature}
                    </li>
                  ))}
                </ul>
              </div>
            </TabsContent>
          ))}
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
