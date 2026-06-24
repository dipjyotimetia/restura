import { Copy, Download, FileText } from 'lucide-react';
import { useMemo } from 'react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  buildDocModel,
  docModelToMarkdown,
  docModelToHtml,
} from '@/features/collections/lib/docGenerator';
import { downloadText } from '@/features/collections/lib/exporters';
import type { Collection } from '@/types';

interface DocsViewerProps {
  /** When non-null the dialog is open and shows docs for this collection. */
  collection: Collection | null;
  onClose: () => void;
}

/**
 * Modal preview of generated API docs for a collection. Renders the
 * self-contained HTML in a sandboxed iframe (the HTML is generated locally with
 * escaping, so no script execution is granted) and offers Markdown / HTML
 * export plus copy-to-clipboard.
 */
export function DocsViewer({ collection, onClose }: DocsViewerProps) {
  const model = useMemo(() => (collection ? buildDocModel(collection) : null), [collection]);
  const html = useMemo(() => (model ? docModelToHtml(model) : ''), [model]);

  const safeName = (collection?.name ?? 'collection').replace(/[^\w.-]+/g, '_');

  const copyMarkdown = async () => {
    if (!model) return;
    try {
      await navigator.clipboard.writeText(docModelToMarkdown(model));
      toast.success('Markdown copied');
    } catch {
      toast.error('Failed to copy');
    }
  };

  const exportMarkdown = () => {
    if (!model) return;
    downloadText(docModelToMarkdown(model), `${safeName}.md`, 'text/markdown');
  };

  const exportHtml = () => {
    if (!model) return;
    downloadText(html, `${safeName}.html`, 'text/html');
  };

  return (
    <Dialog open={collection !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-4xl h-[80vh] flex flex-col p-0 gap-0">
        {/* pr-14 reserves the top-right corner for DialogContent's absolute close button */}
        <DialogHeader className="py-3 pl-4 pr-14 border-b border-sp-line flex-row items-center justify-between space-y-0">
          <div>
            <DialogTitle className="font-mono text-sm tracking-wide flex items-center gap-2">
              <FileText className="h-4 w-4" /> {collection?.name ?? ''} — API Docs
            </DialogTitle>
            <DialogDescription className="sr-only">
              Generated API documentation preview with export options
            </DialogDescription>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={copyMarkdown}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-sp-btn text-sp-12 text-sp-muted hover:text-sp-text hover:bg-sp-hover transition-colors"
            >
              <Copy className="h-3.5 w-3.5" /> Copy MD
            </button>
            <button
              type="button"
              onClick={exportMarkdown}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-sp-btn text-sp-12 text-sp-muted hover:text-sp-text hover:bg-sp-hover transition-colors"
            >
              <Download className="h-3.5 w-3.5" /> .md
            </button>
            <button
              type="button"
              onClick={exportHtml}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-sp-btn text-sp-12 text-sp-muted hover:text-sp-text hover:bg-sp-hover transition-colors"
            >
              <Download className="h-3.5 w-3.5" /> .html
            </button>
          </div>
        </DialogHeader>
        <div className="flex-1 min-h-0 bg-white">
          {collection && (
            <iframe
              srcDoc={html}
              sandbox=""
              className="w-full h-full border-0"
              title={`${collection.name} API documentation`}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default DocsViewer;
