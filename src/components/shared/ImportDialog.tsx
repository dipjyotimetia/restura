import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useCollectionStore } from '@/store/useCollectionStore';
import { importPostmanCollection, importInsomniaCollection, importOpenAPICollection } from '@/features/collections/lib/importers';
import { FileJson, Upload, CheckCircle, AlertCircle } from 'lucide-react';
import YAML from 'yaml';

interface ImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function ImportDialog({ open, onOpenChange }: ImportDialogProps) {
  const { addCollection } = useCollectionStore();
  const [importStatus, setImportStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [activeTab, setActiveTab] = useState('postman');

  const parseFileContent = (text: string, fileName: string): unknown => {
    if (fileName.endsWith('.yaml') || fileName.endsWith('.yml')) {
      return YAML.parse(text);
    }
    return JSON.parse(text);
  };

  const processImportFile = async (file: File, type: 'postman' | 'insomnia' | 'openapi') => {
    const text = await file.text();
    const data = parseFileContent(text, file.name);

    if (type === 'postman') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return importPostmanCollection(data as any);
    } else if (type === 'insomnia') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return importInsomniaCollection(data as any);
    } else {
      return importOpenAPICollection(data);
    }
  };

  const handleImportSuccess = (collection: ReturnType<typeof importPostmanCollection>) => {
    addCollection(collection);
    setImportStatus('success');
    setTimeout(() => {
      onOpenChange(false);
      setImportStatus('idle');
    }, 1500);
  };

  const handleImportError = (error: unknown) => {
    setImportStatus('error');
    const message = error instanceof Error ? error.message : 'Failed to import collection';
    setErrorMessage(message);
    setTimeout(() => setImportStatus('idle'), 3000);
  };

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>, type: 'postman' | 'insomnia' | 'openapi') => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const collection = await processImportFile(file, type);
      handleImportSuccess(collection);
    } catch (error: unknown) {
      handleImportError(error);
    }

    event.target.value = '';
  };

  const handleDrop = async (event: React.DragEvent<HTMLDivElement>, type: 'postman' | 'insomnia' | 'openapi') => {
    event.preventDefault();
    const file = event.dataTransfer.files?.[0];
    if (!file) return;

    try {
      const collection = await processImportFile(file, type);
      handleImportSuccess(collection);
    } catch (error: unknown) {
      handleImportError(error);
    }
  };

  const DropZone = ({ type }: { type: 'postman' | 'insomnia' | 'openapi' }) => {
    const typeLabels = {
      postman: 'Postman',
      insomnia: 'Insomnia',
      openapi: 'OpenAPI / Swagger',
    };

    return (
      <div
        onDrop={(e) => handleDrop(e, type)}
        onDragOver={(e) => e.preventDefault()}
        className="border border-dashed border-border rounded-lg p-10 text-center hover:border-primary/50 hover:bg-surface-2/50 transition-colors cursor-pointer"
      >
        <input
          type="file"
          accept=".json,.yaml,.yml"
          onChange={(e) => handleFileUpload(e, type)}
          className="hidden"
          id={`file-upload-${type}`}
        />
        <label htmlFor={`file-upload-${type}`} className="cursor-pointer block">
          <div className="flex flex-col items-center gap-3">
            <FileJson className="h-10 w-10 text-muted-foreground/40" />
            <div>
              <p className="text-sm font-mono text-muted-foreground">
                Drop {typeLabels[type]} collection here
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
  };

  const FEATURE_LISTS: Record<string, string[]> = {
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
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-mono text-sm tracking-wide">IMPORT COLLECTION</DialogTitle>
          <DialogDescription className="font-mono text-xs">
            Import from Postman, Insomnia, or OpenAPI/Swagger
          </DialogDescription>
        </DialogHeader>

        {importStatus === 'success' && (
          <div className="flex items-center gap-2 p-3 bg-emerald-500/10 border border-emerald-500/20 rounded text-emerald-400 text-xs font-mono">
            <CheckCircle className="h-4 w-4 shrink-0" />
            <span>Collection imported successfully!</span>
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

        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
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
          </TabsList>

          {(['postman', 'insomnia', 'openapi'] as const).map((type) => (
            <TabsContent key={type} value={type} className="space-y-4 mt-4">
              <DropZone type={type} />
              <div className="space-y-1.5">
                <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                  Supported Features
                </p>
                <ul className="space-y-1">
                  {FEATURE_LISTS[type]?.map((feature) => (
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
