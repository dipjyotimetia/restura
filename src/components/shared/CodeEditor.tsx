'use client';

import { useRef, useState } from 'react';
import Editor, { OnMount } from '@monaco-editor/react';
import { useTheme } from 'next-themes';
import type * as Monaco from 'monaco-editor';
import { Copy, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { registerGraphQLLanguage } from '@/features/graphql/lib/monacoGraphql';

interface CodeEditorProps {
  value: string;
  onChange?: (value: string) => void;
  language?: string;
  readOnly?: boolean;
  height?: string | number;
  minimap?: boolean;
  showCopyButton?: boolean;
}

export default function CodeEditor({
  value,
  onChange,
  language = 'json',
  readOnly = false,
  height = '400px',
  minimap = false,
  showCopyButton = true,
}: CodeEditorProps) {
  const { theme } = useTheme();
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const [copied, setCopied] = useState(false);

  const handleEditorDidMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;

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
      automaticLayout: true,
      tabSize: 2,
      readOnly,
    });

    // Auto-format on mount if JSON
    if (language === 'json' && value) {
      try {
        editor.getAction('editor.action.formatDocument')?.run();
      } catch (e) {
        // Ignore formatting errors
      }
    }
  };

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
    } catch (err) {
      toast.error('Failed to copy to clipboard');
    }
  };

  return (
    <div className="relative border border-border rounded-lg overflow-hidden group h-full bg-background">
      {showCopyButton && value && (
        <Button
          variant="ghost"
          size="icon"
          className="absolute top-2 right-2 z-10 h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity bg-background border border-border hover:bg-accent shadow-md"
          onClick={handleCopy}
          title="Copy to clipboard"
        >
          {copied ? (
            <Check className="h-4 w-4 text-green-500" />
          ) : (
            <Copy className="h-4 w-4" />
          )}
        </Button>
      )}
      <Editor
        height={height}
        language={language}
        value={value}
        theme={theme === 'dark' ? 'vs-dark' : 'vs-light'}
        onChange={handleChange}
        onMount={handleEditorDidMount}
        options={{
          readOnly,
          minimap: { enabled: minimap },
          scrollBeyondLastLine: false,
          fontSize: 13,
          lineNumbers: 'on',
          wordWrap: 'on',
          automaticLayout: true,
        }}
      />
    </div>
  );
}
