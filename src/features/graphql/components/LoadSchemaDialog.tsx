'use client';

import { AlertCircle, FileUp, Upload } from 'lucide-react';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import type { GraphQLImportedSchema } from '@/types';
import { parseSchemaSource } from '../lib/schemaImport';

interface LoadSchemaDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onLoad: (schema: GraphQLImportedSchema, typeCount: number) => void;
}

const ACCEPT = '.graphql,.graphqls,.gql,.json,application/json,application/graphql';

/**
 * Load a GraphQL schema by hand — for endpoints with introspection disabled.
 * Accepts an SDL file (.graphql/.graphqls/.gql), pasted SDL, or an
 * introspection JSON result (file or paste).
 */
export function LoadSchemaDialog({ open, onOpenChange, onLoad }: LoadSchemaDialogProps) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const fileInputId = useId();

  const reset = () => {
    setText('');
    setError(null);
  };

  const tryLoad = (source: string, fileName?: string) => {
    const parsed = parseSchemaSource(source, fileName ? { fileName } : {});
    if (!parsed.ok) {
      setError(fileName ? `${fileName}: ${parsed.error}` : parsed.error);
      return;
    }
    onLoad(parsed.schema, parsed.typeCount);
    reset();
  };

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      tryLoad(await file.text(), file.name);
    } catch (err) {
      setError(`Could not read ${file.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader icon={FileUp}>
          <DialogTitle>Load GraphQL schema</DialogTitle>
          <DialogDescription>
            For endpoints with introspection disabled. Choose a .graphql / .graphqls SDL file or an
            introspection JSON result, or paste either below. The schema is saved with this request
            and drives autocomplete, validation and the schema explorer.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <label
              htmlFor={fileInputId}
              className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-sp-btn border border-sp-line text-sp-12 font-medium text-sp-text cursor-pointer hover:bg-sp-hover"
            >
              <Upload className="h-3.5 w-3.5" />
              Choose schema file
            </label>
            <input
              id={fileInputId}
              type="file"
              accept={ACCEPT}
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                void handleFile(file);
              }}
            />
            <span className="text-sp-11 text-sp-dim">.graphql, .graphqls, .gql or .json</span>
          </div>

          <Textarea
            aria-label="Schema source (SDL or introspection JSON)"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              if (error) setError(null);
            }}
            placeholder={
              'type Query {\n  hello: String\n}\n\n…or paste an introspection JSON result'
            }
            spellCheck={false}
            className="font-mono text-sp-12 min-h-[220px]"
          />

          {error && (
            <div
              role="alert"
              className="flex items-start gap-1.5 px-2 py-1.5 rounded-sp-btn border text-sp-11 font-mono"
              style={{
                background: 'color-mix(in srgb, var(--color-danger) 8%, transparent)',
                borderColor: 'color-mix(in srgb, var(--color-danger) 25%, transparent)',
                color: 'var(--color-danger)',
              }}
            >
              <AlertCircle className="h-3 w-3 mt-0.5 shrink-0" />
              <span className="whitespace-pre-wrap break-words">{error}</span>
            </div>
          )}
        </div>

        <DialogFooter className="items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => tryLoad(text)} disabled={!text.trim()}>
            Load
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
