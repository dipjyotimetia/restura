import { Paperclip, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { base64ByteLength, formatBytes } from '@/features/http/lib/fileEncoding';
import { readFileAsBase64 } from '@/lib/shared/file-utils';

interface BinaryBodyPickerProps {
  /** base64-encoded body bytes (lives in request.body.raw). */
  base64: string;
  onChange: (base64: string) => void;
}

/**
 * Binary request-body picker. The chosen file's bytes are base64-encoded into
 * `request.body.raw`; the shared body-builder decodes them to octet-stream bytes
 * at send time. The filename is display-only (not persisted) — the wire body is
 * just the bytes.
 */
export default function BinaryBodyPicker({ base64, onChange }: BinaryBodyPickerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const size = base64 ? formatBytes(base64ByteLength(base64)) : null;

  const pick = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    setFileName(file.name);
    onChange(await readFileAsBase64(file));
  };

  const clear = (): void => {
    setFileName(null);
    onChange('');
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
      <div className="inline-flex items-center justify-center h-10 w-10 rounded-full bg-sp-surface-lo text-sp-dim">
        <Paperclip size={18} />
      </div>
      {base64 ? (
        <div className="flex items-center gap-2">
          <span className="text-sp-13 text-sp-text font-mono">
            {fileName ? `${fileName} ` : ''}
            <span className="text-sp-muted">{size}</span>
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={clear}
            aria-label="Clear binary body"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      ) : (
        <p className="text-sp-11 text-sp-dim">Choose a file to send as the raw request body.</p>
      )}
      <Button variant="outline" size="sm" onClick={() => inputRef.current?.click()}>
        <Paperclip className="mr-1.5 h-3.5 w-3.5" />
        {base64 ? 'Replace file' : 'Choose file'}
      </Button>
      <input
        ref={inputRef}
        type="file"
        aria-label="Choose request body file"
        className="hidden"
        onChange={(e) => void pick(e.target.files?.[0])}
      />
    </div>
  );
}
