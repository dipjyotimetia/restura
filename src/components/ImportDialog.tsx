'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useCollectionStore } from '@/store/useCollectionStore';
import { importPostmanCollection, importInsomniaCollection } from '@/lib/importers';
import { FileJson, Upload, CheckCircle, AlertCircle } from 'lucide-react';

interface ImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function ImportDialog({ open, onOpenChange }: ImportDialogProps) {
  const { addCollection } = useCollectionStore();
  const [importStatus, setImportStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [activeTab, setActiveTab] = useState('postman');

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>, type: 'postman' | 'insomnia') => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const data = JSON.parse(text);

      let collection;
      if (type === 'postman') {
        collection = importPostmanCollection(data);
      } else {
        collection = importInsomniaCollection(data);
      }

      addCollection(collection);
      setImportStatus('success');
      setTimeout(() => {
        onOpenChange(false);
        setImportStatus('idle');
      }, 1500);
    } catch (error: unknown) {
      setImportStatus('error');
      const errorMessage = error instanceof Error ? error.message : 'Failed to import collection';
      setErrorMessage(errorMessage);
      setTimeout(() => setImportStatus('idle'), 3000);
    }

    // Reset input
    event.target.value = '';
  };

  const handleDrop = async (event: React.DragEvent<HTMLDivElement>, type: 'postman' | 'insomnia') => {
    event.preventDefault();
    const file = event.dataTransfer.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const data = JSON.parse(text);

      let collection;
      if (type === 'postman') {
        collection = importPostmanCollection(data);
      } else {
        collection = importInsomniaCollection(data);
      }

      addCollection(collection);
      setImportStatus('success');
      setTimeout(() => {
        onOpenChange(false);
        setImportStatus('idle');
      }, 1500);
    } catch (error: unknown) {
      setImportStatus('error');
      const errorMessage = error instanceof Error ? error.message : 'Failed to import collection';
      setErrorMessage(errorMessage);
      setTimeout(() => setImportStatus('idle'), 3000);
    }
  };

  const DropZone = ({ type }: { type: 'postman' | 'insomnia' }) => (
    <div
      onDrop={(e) => handleDrop(e, type)}
      onDragOver={(e) => e.preventDefault()}
      className="border-2 border-dashed rounded-lg p-12 text-center hover:border-primary transition-colors"
    >
      <input
        type="file"
        accept=".json"
        onChange={(e) => handleFileUpload(e, type)}
        className="hidden"
        id={`file-upload-${type}`}
      />
      <label htmlFor={`file-upload-${type}`} className="cursor-pointer">
        <div className="flex flex-col items-center gap-4">
          <FileJson className="h-12 w-12 text-muted-foreground" />
          <div>
            <p className="text-lg font-medium">
              Drop {type === 'postman' ? 'Postman' : 'Insomnia'} collection here
            </p>
            <p className="text-sm text-muted-foreground mt-1">or click to browse</p>
          </div>
          <Button variant="outline" size="sm" type="button">
            <Upload className="mr-2 h-4 w-4" />
            Choose File
          </Button>
        </div>
      </label>
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import Collection</DialogTitle>
          <DialogDescription>
            Import your API collections from Postman or Insomnia
          </DialogDescription>
        </DialogHeader>

        {importStatus === 'success' && (
          <div className="flex items-center gap-2 p-4 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg text-green-800 dark:text-green-200">
            <CheckCircle className="h-5 w-5" />
            <span className="font-medium">Collection imported successfully!</span>
          </div>
        )}

        {importStatus === 'error' && (
          <div className="flex items-center gap-2 p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-red-800 dark:text-red-200">
            <AlertCircle className="h-5 w-5" />
            <div className="flex-1">
              <span className="font-medium">Import failed</span>
              <p className="text-sm mt-1">{errorMessage}</p>
            </div>
          </div>
        )}

        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="postman">Postman</TabsTrigger>
            <TabsTrigger value="insomnia">Insomnia</TabsTrigger>
          </TabsList>

          <TabsContent value="postman" className="space-y-4">
            <DropZone type="postman" />
            <div className="text-sm text-muted-foreground space-y-2">
              <p className="font-medium">Supported Postman features:</p>
              <ul className="list-disc list-inside space-y-1 ml-2">
                <li>Collections and folders</li>
                <li>HTTP requests (all methods)</li>
                <li>Query parameters and headers</li>
                <li>Request body (JSON, form-data, etc.)</li>
                <li>Authentication (Basic, Bearer, API Key, OAuth2, AWS Signature)</li>
                <li>Pre-request and test scripts</li>
                <li>Environment variables</li>
              </ul>
            </div>
          </TabsContent>

          <TabsContent value="insomnia" className="space-y-4">
            <DropZone type="insomnia" />
            <div className="text-sm text-muted-foreground space-y-2">
              <p className="font-medium">Supported Insomnia features:</p>
              <ul className="list-disc list-inside space-y-1 ml-2">
                <li>Workspaces and request groups</li>
                <li>HTTP requests</li>
                <li>Headers and parameters</li>
                <li>Request body</li>
                <li>Authentication (Basic, Bearer, API Key, OAuth2)</li>
              </ul>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
