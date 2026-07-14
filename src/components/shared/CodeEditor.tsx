'use client';

import '@/lib/shared/monaco-setup';
import type { OnMount } from '@monaco-editor/react';
import Editor from '@monaco-editor/react';
import { Check, Copy } from 'lucide-react';
import type * as Monaco from 'monaco-editor';
import { useTheme } from 'next-themes';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { registerGraphQLLanguage } from '@/features/graphql/lib/monacoGraphql';
import { findVariableTokens } from '@/lib/shared/variableTokens';

interface CodeEditorProps {
  value: string;
  onChange?: (value: string) => void;
  language?: string;
  readOnly?: boolean;
  height?: string | number;
  minimap?: boolean;
  showCopyButton?: boolean;
  onEditorMount?: (editor: Monaco.editor.IStandaloneCodeEditor, monaco: typeof Monaco) => void;
  /**
   * Optional Monaco model path. When provided, @monaco-editor/react keeps a
   * dedicated ITextModel per path so cursor, selection, fold state and the
   * undo stack survive remounts/tab switches. Use a stable, unique key per
   * editor role (e.g. `tab-<id>-body`).
   */
  path?: string;
  /**
   * When provided, `{{var}}` tokens in the content are decorated inline:
   * resolved → accent token style, unresolved → warning style with a hover.
   * Receives the inner variable name (braces stripped, trimmed). Omit to leave
   * the content undecorated.
   */
  getVariableStatus?: (name: string) => 'resolved' | 'unresolved';
}

export default function CodeEditor({
  value,
  onChange,
  language = 'json',
  readOnly = false,
  height = '400px',
  minimap = false,
  showCopyButton = true,
  onEditorMount,
  path,
  getVariableStatus,
}: CodeEditorProps) {
  const { theme } = useTheme();
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof Monaco | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const decorationsRef = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null);
  const contentListenerRef = useRef<Monaco.IDisposable | null>(null);
  // Keep the latest classifier reachable from the (once-bound) content-change
  // listener without re-subscribing on every render.
  const getVariableStatusRef = useRef(getVariableStatus);
  const [copied, setCopied] = useState(false);

  // Recompute the {{var}} decorations from the current model contents. Resolved
  // tokens get the accent style; unresolved ones get a warning style + hover.
  const applyVariableDecorations = useCallback(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;
    const model = editor.getModel();
    if (!model) return;
    const classify = getVariableStatusRef.current;
    if (!classify) {
      decorationsRef.current?.clear();
      return;
    }
    const text = model.getValue();
    const decorations: Monaco.editor.IModelDeltaDecoration[] = findVariableTokens(text).map(
      (token) => {
        const startPos = model.getPositionAt(token.start);
        const endPos = model.getPositionAt(token.end);
        const unresolved = classify(token.name) === 'unresolved';
        return {
          range: new monaco.Range(
            startPos.lineNumber,
            startPos.column,
            endPos.lineNumber,
            endPos.column
          ),
          options: {
            inlineClassName: unresolved ? 'monaco-var-unresolved' : 'monaco-var-resolved',
            ...(unresolved
              ? { hoverMessage: { value: `Unresolved variable: \`${token.name}\`` } }
              : {}),
          },
        };
      }
    );
    if (decorationsRef.current) {
      decorationsRef.current.set(decorations);
    } else {
      decorationsRef.current = editor.createDecorationsCollection(decorations);
    }
  }, []);

  const handleEditorDidMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    onEditorMount?.(editor, monaco);

    // Register GraphQL language if needed
    if (language === 'graphql') {
      registerGraphQLLanguage(monaco);
    }

    // Configure editor options
    editor.updateOptions({
      fontSize: 13,
      lineNumbers: 'on',
      minimap: { enabled: minimap },
      scrollBeyondLastLine: false,
      wordWrap: 'on',
      wrappingIndent: 'indent',
      automaticLayout: false, // We will handle layout manually with ResizeObserver for better performance/reliability
      tabSize: 2,
      readOnly,
    });

    // Auto-format on mount if JSON
    if (language === 'json' && value) {
      try {
        editor.getAction('editor.action.formatDocument')?.run();
      } catch {
        // Ignore formatting errors
      }
    }

    // Initial layout
    editor.layout();

    // Variable highlighting: paint once, then on every model edit (covers both
    // typing and external value-prop updates, which Monaco applies as edits).
    applyVariableDecorations();
    contentListenerRef.current = editor.onDidChangeModelContent(() => applyVariableDecorations());
  };

  // Dispose the content-change listener and decorations on unmount. (Monaco
  // also tears these down with the editor, but releasing explicitly keeps the
  // lifecycle self-contained.)
  useEffect(() => {
    return () => {
      contentListenerRef.current?.dispose();
      decorationsRef.current?.clear();
    };
  }, []);

  // Re-decorate when the classifier identity changes (e.g. the active
  // environment switched, so resolved/unresolved verdicts change).
  useEffect(() => {
    getVariableStatusRef.current = getVariableStatus;
    applyVariableDecorations();
  }, [getVariableStatus, applyVariableDecorations]);

  // Handle resizing
  useEffect(() => {
    if (!containerRef.current) return;

    const resizeObserver = new ResizeObserver(() => {
      if (editorRef.current) {
        editorRef.current.layout();
      }
    });

    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
    };
  }, []);

  const handleChange = (value: string | undefined) => {
    if (onChange && value !== undefined) {
      onChange(value);
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success('Copied to clipboard');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Failed to copy to clipboard');
    }
  };

  return (
    <div
      ref={containerRef}
      className="relative border border-border rounded-lg overflow-hidden group h-full bg-background"
    >
      {showCopyButton && value && (
        <Button
          variant="ghost"
          size="icon"
          className="absolute top-2 right-2 z-10 h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity bg-background border border-border hover:bg-accent shadow-md"
          onClick={handleCopy}
          title="Copy to clipboard"
        >
          {copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />}
        </Button>
      )}
      <Editor
        height={height}
        language={language}
        value={value}
        loading={
          <div className="flex h-full w-full items-center justify-center">
            <span className="text-sp-12 font-mono text-sp-dim animate-pulse">Loading editor…</span>
          </div>
        }
        theme={theme === 'dark' ? 'restura-dark' : 'restura-light'}
        onChange={handleChange}
        onMount={handleEditorDidMount}
        {...(path !== undefined && { path })}
        options={{
          readOnly,
          minimap: { enabled: minimap },
          scrollBeyondLastLine: false,
          fontSize: 13,
          fontFamily: '"JetBrains Mono", "SF Mono", Menlo, ui-monospace, monospace',
          lineNumbers: 'on',
          wordWrap: 'on',
          automaticLayout: true,
        }}
      />
    </div>
  );
}
