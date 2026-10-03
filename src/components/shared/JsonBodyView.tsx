import { Braces, Check, Copy, Download, Search } from 'lucide-react';
import type * as Monaco from 'monaco-editor';
import { useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { IconButton } from '@/components/shared/ResponseToolbarButtons';
import { Skeleton } from '@/components/ui/skeleton';
import { Segmented } from '@/components/ui/spatial';
import { TooltipProvider } from '@/components/ui/tooltip';
import { lazyComponent } from '@/lib/shared/lazyComponent';
import { downloadFileName } from '@/lib/shared/responseFiles';

// Above this size pretty-printing and the tree are skipped (main-thread cost).
const PRETTY_MAX_BYTES = 1_000_000;

const skeleton = (
  <div className="p-4">
    <Skeleton className="h-4 w-1/2 rounded" />
  </div>
);
const CodeEditor = lazyComponent(() => import('@/components/shared/CodeEditor'), skeleton);
const JsonTree = lazyComponent(() => import('@/components/shared/JsonTree'), skeleton);
const JsonPathQuery = lazyComponent(() => import('@/components/shared/JsonPathQuery'), skeleton);

type Format = 'pretty' | 'raw' | 'tree';

/** Parse JSON text; `undefined` when it isn't JSON (or is too large to parse). */
export function parseJsonBody(text: string): { value: unknown } | undefined {
  if (text.length > PRETTY_MAX_BYTES) return undefined;
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return undefined;
  }
}

interface JsonBodyViewProps {
  /** The result as text — JSON is pretty-printable, tree-viewable and queryable. */
  text: string;
  /** Base name for the downloaded file (an extension is added). */
  downloadName: string;
  /** Monaco model path, so view state survives remounts per tab. */
  editorPath?: string;
}

/**
 * A JSON result body for non-HTTP protocols (gRPC, MCP): Pretty / Raw / Tree,
 * JSONPath query, find, copy and download — the HTTP response body's tools.
 */
export function JsonBodyView({ text, downloadName, editorPath }: JsonBodyViewProps) {
  const [format, setFormat] = useState<Format>('pretty');
  const [showJsonPath, setShowJsonPath] = useState(false);
  const [copied, setCopied] = useState(false);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);

  const parsed = useMemo(() => parseJsonBody(text), [text]);
  const shown = format === 'pretty' && parsed ? JSON.stringify(parsed.value, null, 2) : text;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shown);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      toast.success('Result copied');
    } catch {
      toast.error('Failed to copy result');
    }
  };

  const download = () => {
    const blob = new Blob([shown], { type: parsed ? 'application/json' : 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = downloadFileName(downloadName, parsed ? 'json' : 'txt');
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 items-center justify-end gap-2 border-b border-sp-line px-3 py-1.5">
          <Segmented
            size="sm"
            value={format}
            onChange={setFormat}
            options={[
              { value: 'pretty', label: 'Pretty' },
              { value: 'raw', label: 'Raw' },
              ...(parsed ? [{ value: 'tree' as const, label: 'Tree' }] : []),
            ]}
            ariaLabel="Result format"
          />
          {parsed && (
            <IconButton
              icon={<Braces className="h-3.5 w-3.5" />}
              label="Query with JSONPath"
              active={showJsonPath}
              onClick={() => setShowJsonPath((v) => !v)}
            />
          )}
          {format !== 'tree' && !showJsonPath && (
            <IconButton
              icon={<Search className="h-3.5 w-3.5" />}
              label="Find in result (Ctrl+F)"
              onClick={() => editorRef.current?.getAction('actions.find')?.run()}
            />
          )}
          <IconButton
            icon={
              copied ? (
                <Check className="h-3.5 w-3.5 text-emerald-400" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )
            }
            label={copied ? 'Copied!' : 'Copy result'}
            onClick={copy}
          />
          <IconButton
            icon={<Download className="h-3.5 w-3.5" />}
            label="Download result"
            onClick={download}
          />
        </div>
        <div className="relative min-h-0 flex-1" style={{ background: 'var(--sp-code)' }}>
          {showJsonPath && parsed ? (
            <JsonPathQuery body={text} onClose={() => setShowJsonPath(false)} />
          ) : format === 'tree' && parsed ? (
            <JsonTree value={parsed.value} />
          ) : (
            <CodeEditor
              value={shown}
              language={parsed ? 'json' : 'plaintext'}
              readOnly
              height="100%"
              showCopyButton={false}
              formatOnMount={false}
              onEditorMount={(editor) => {
                editorRef.current = editor;
              }}
              {...(editorPath && { path: editorPath })}
            />
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}
