'use client';

import { Check, Copy } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Segmented } from '@/components/ui/spatial';

export interface ProtocolCodeGenerator<T> {
  name: string;
  generate: (options: T) => string;
}

export interface ProtocolCodeDialogProps<T> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  /** Language key → generator; the first entry is the default. */
  generators: Record<string, ProtocolCodeGenerator<T>>;
  /** The request, already shaped for the generators. */
  options: T;
}

/**
 * Generic "export as code" dialog for the non-HTTP protocols (GraphQL, gRPC,
 * WebSocket, SSE, MCP…): language picker, read-only code view, copy button.
 * Generators receive `options` verbatim, so callers decide what goes in
 * (e.g. explicit headers only, `{{vars}}` unresolved — never secret plaintext).
 */
export function ProtocolCodeDialog<T>({
  open,
  onOpenChange,
  title,
  description,
  generators,
  options,
}: ProtocolCodeDialogProps<T>) {
  const keys = Object.keys(generators);
  const [picked, setPicked] = useState<string | undefined>(keys[0]);
  const language = picked && Object.hasOwn(generators, picked) ? picked : keys[0];
  const generator = language ? generators[language] : undefined;
  const [copied, setCopied] = useState(false);

  const { code, error } = useMemo(() => {
    if (!open || !generator) return { code: '', error: null };
    try {
      return { code: generator.generate(options), error: null };
    } catch (err) {
      return { code: '', error: err instanceof Error ? err.message : String(err) };
    }
  }, [open, generator, options]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast.success('Copied to clipboard');
    } catch (err) {
      toast.error('Copy failed', { description: err instanceof Error ? err.message : undefined });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {description ?? 'Export this request as code you can run elsewhere.'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2">
          {language && (
            <Segmented<string>
              options={keys.map((key) => ({ value: key, label: generators[key]?.name ?? key }))}
              value={language}
              onChange={setPicked}
              size="sm"
              ariaLabel="Code language"
            />
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleCopy()}
            disabled={!code}
            className="ml-auto gap-2"
          >
            {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            {copied ? 'Copied!' : 'Copy'}
          </Button>
        </div>

        {error ? (
          <p role="alert" className="text-sp-12 text-destructive">
            Could not generate code: {error}
          </p>
        ) : (
          <figure
            aria-label={`Generated ${generator?.name ?? ''} code`}
            className="flex-1 min-h-0 m-0 flex"
          >
            <pre className="flex-1 overflow-auto p-4 bg-muted rounded-lg font-mono text-sm whitespace-pre">
              <code>{code}</code>
            </pre>
          </figure>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default ProtocolCodeDialog;
