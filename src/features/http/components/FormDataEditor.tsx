import { Plus, Trash2, Paperclip, ListPlus } from 'lucide-react';
import { useRef } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { VariableInput } from '@/components/shared/VariableInput';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/spatial';
import { Switch } from '@/components/ui/switch';
import { base64ByteLength, formatBytes } from '@/features/http/lib/fileEncoding';
import { readFileAsBase64 } from '@/lib/shared/file-utils';
import type { FormDataItem } from '@/types';

interface FormDataEditorProps {
  items: FormDataItem[];
  onChange: (items: FormDataItem[]) => void;
}

const ROW_TYPES = [
  { value: 'text' as const, label: 'text' },
  { value: 'file' as const, label: 'file' },
];

/**
 * multipart/form-data field editor. Text rows are plain key/value; file rows pick
 * a file whose bytes are base64-encoded into `value` (with `fileName`/`contentType`)
 * so the wire body is well-formed and the field survives persistence + IPC.
 */
export default function FormDataEditor({ items, onChange }: FormDataEditorProps) {
  const update = (id: string, patch: Partial<FormDataItem>): void =>
    onChange(items.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  const remove = (id: string): void => onChange(items.filter((it) => it.id !== id));
  const add = (): void =>
    onChange([...items, { id: uuidv4(), key: '', value: '', enabled: true, type: 'text' }]);

  const setType = (item: FormDataItem, type: 'text' | 'file'): void => {
    if (type === item.type) return;
    // Switching type clears the value and drops any file metadata so base64 bytes
    // never render as text and typed text is never sent as a file.
    const { fileName: _fileName, contentType: _contentType, ...base } = item;
    onChange(items.map((it) => (it.id === item.id ? { ...base, type, value: '' } : it)));
  };

  const pickFile = async (id: string, file: File | undefined): Promise<void> => {
    if (!file) return;
    update(id, {
      value: await readFileAsBase64(file),
      fileName: file.name,
      contentType: file.type || 'application/octet-stream',
    });
  };

  return (
    <div className="space-y-2">
      {items.length === 0 && (
        <div className="flex flex-col items-center justify-center py-8 gap-2 text-sp-dim sp-inset rounded-xl mx-1">
          <ListPlus className="h-5 w-5 text-primary/40" />
          <p className="text-sp-11 font-mono">No fields added</p>
        </div>
      )}
      {items.map((item) => (
        <div
          key={item.id}
          className="flex items-center gap-2 group py-1.5 px-2 rounded border border-transparent hover:bg-foreground/5 transition-colors"
        >
          <Switch
            checked={item.enabled}
            onCheckedChange={(checked) => update(item.id, { enabled: checked })}
            className="data-[state=checked]:bg-primary"
            aria-label={item.enabled ? 'Disable field' : 'Enable field'}
          />
          <VariableInput
            value={item.key}
            onValueChange={(val) => update(item.id, { key: val })}
            placeholder="Key"
            className="flex-1 font-mono text-xs"
            aria-label="Field key"
          />
          <Segmented<'text' | 'file'>
            size="sm"
            value={item.type}
            onChange={(t) => setType(item, t)}
            ariaLabel="Field type"
            options={ROW_TYPES}
          />
          <div className="flex-1 min-w-0">
            {item.type === 'file' ? (
              <FilePickerCell item={item} onPick={(f) => void pickFile(item.id, f)} />
            ) : (
              <VariableInput
                value={item.value}
                onValueChange={(val) => update(item.id, { value: val })}
                placeholder="Value"
                className="w-full font-mono text-xs"
                aria-label="Field value"
              />
            )}
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
            onClick={() => remove(item.id)}
            aria-label="Delete field"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}
      <Button onClick={add} variant="outline" size="sm">
        <Plus className="mr-2 h-4 w-4" />
        Add field
      </Button>
    </div>
  );
}

function FilePickerCell({
  item,
  onPick,
}: {
  item: FormDataItem;
  onPick: (file: File | undefined) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const size = item.value ? formatBytes(base64ByteLength(item.value)) : null;
  return (
    <div className="flex items-center gap-2 min-w-0">
      <Button
        variant="outline"
        size="sm"
        className="shrink-0"
        onClick={() => inputRef.current?.click()}
        aria-label="Choose file"
      >
        <Paperclip className="mr-1.5 h-3.5 w-3.5" />
        {item.fileName ? 'Replace' : 'Choose file'}
      </Button>
      <span className="truncate text-xs font-mono text-sp-muted" title={item.fileName ?? ''}>
        {item.fileName ? `${item.fileName}${size ? ` (${size})` : ''}` : 'no file selected'}
      </span>
      <input
        ref={inputRef}
        type="file"
        aria-label="Choose file"
        className="hidden"
        onChange={(e) => onPick(e.target.files?.[0])}
      />
    </div>
  );
}
