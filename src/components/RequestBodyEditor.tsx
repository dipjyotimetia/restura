'use client';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { RequestBody } from '@/types';
import dynamic from 'next/dynamic';

const CodeEditor = dynamic(() => import('@/components/CodeEditor'), { ssr: false });

interface RequestBodyEditorProps {
  body: RequestBody;
  onBodyTypeChange: (type: RequestBody['type']) => void;
  onBodyContentChange: (content: string) => void;
}

export default function RequestBodyEditor({
  body,
  onBodyTypeChange,
  onBodyContentChange,
}: RequestBodyEditorProps) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <Select value={body.type} onValueChange={(value) => onBodyTypeChange(value as RequestBody['type'])}>
          <SelectTrigger className="w-48 border-white/10 dark:border-white/5">
            <SelectValue placeholder="Select body type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">None</SelectItem>
            <SelectItem value="json">JSON</SelectItem>
            <SelectItem value="xml">XML</SelectItem>
            <SelectItem value="text">Text</SelectItem>
            <SelectItem value="form-data">Form Data</SelectItem>
            <SelectItem value="x-www-form-urlencoded">x-www-form-urlencoded</SelectItem>
          </SelectContent>
        </Select>
        {body.type !== 'none' && (
          <span className="text-xs text-muted-foreground">
            Content-Type will be set automatically based on body type
          </span>
        )}
      </div>

      {body.type === 'none' ? (
        <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
          <p className="text-sm">No body content</p>
          <p className="text-xs mt-1">Select a body type above to add request body</p>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">
              {body.type === 'json' && 'JSON Body'}
              {body.type === 'xml' && 'XML Body'}
              {body.type === 'text' && 'Plain Text Body'}
              {body.type === 'form-data' && 'Form Data (Raw)'}
              {body.type === 'x-www-form-urlencoded' && 'URL Encoded Form Data'}
            </span>
            {body.raw && (
              <span className="text-xs text-muted-foreground">
                {new Blob([body.raw]).size} bytes
              </span>
            )}
          </div>
          <CodeEditor
            value={body.raw || ''}
            onChange={onBodyContentChange}
            language={body.type === 'json' ? 'json' : body.type === 'xml' ? 'xml' : 'plaintext'}
            height="300px"
          />
        </div>
      )}
    </div>
  );
}
