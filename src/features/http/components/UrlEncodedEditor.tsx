import { Plus, X } from 'lucide-react';
import { useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { VariableInput } from '@/components/shared/VariableInput';
import { Segmented } from '@/components/ui/spatial';
import { ToggleField } from '@/components/ui/spatial/ToggleField';
import { parseUrlEncoded, urlEncodedRaw } from '@/lib/shared/urlEncodedBody';
import type { FormDataItem } from '@/types';

interface UrlEncodedEditorProps {
  items: FormDataItem[];
  onChange: (items: FormDataItem[]) => void;
}

const inputClass =
  'w-full bg-transparent outline-none font-mono text-sp-12 text-sp-text placeholder:text-sp-dim px-2 py-1.5 focus:bg-sp-hover';

/** Key/value table (or encoded text) for an x-www-form-urlencoded body. */
export default function UrlEncodedEditor({ items, onChange }: UrlEncodedEditorProps) {
  const [mode, setMode] = useState<'table' | 'text'>('table');
  // While typing in Text mode, show the text as typed: re-deriving it from the
  // parsed fields would drop a trailing '&' or '=' mid-edit.
  const [draft, setDraft] = useState<string | null>(null);
  const update = (id: string, patch: Partial<FormDataItem>) =>
    onChange(items.map((item) => (item.id === id ? { ...item, ...patch } : item)));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex justify-end border-b border-sp-line px-2 py-1">
        <Segmented<'table' | 'text'>
          options={[
            { value: 'table', label: 'Table' },
            { value: 'text', label: 'Text' },
          ]}
          value={mode}
          onChange={setMode}
          size="sm"
          ariaLabel="Form body view"
        />
      </div>
      {mode === 'text' ? (
        <textarea
          aria-label="Encoded form body"
          spellCheck={false}
          value={draft ?? urlEncodedRaw(items)}
          onBlur={() => setDraft(null)}
          onChange={(e) => {
            setDraft(e.target.value);
            // Text edits rebuild the enabled fields; disabled ones are kept.
            onChange([
              ...parseUrlEncoded(e.target.value).map((f) => ({
                id: uuidv4(),
                ...f,
                enabled: true,
                type: 'text' as const,
              })),
              ...items.filter((i) => !i.enabled),
            ]);
          }}
          placeholder="name=Ada&role=admin"
          className="flex-1 min-h-0 resize-none bg-transparent p-3 font-mono text-sp-12 text-sp-text outline-none"
        />
      ) : (
        <div className="flex-1 min-h-0 overflow-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="text-left text-sp-11 text-sp-dim">
                <th className="w-8">
                  <span className="sr-only">Enabled</span>
                </th>
                <th className="px-2 py-1.5 font-medium">Key</th>
                <th className="px-2 py-1.5 font-medium">Value</th>
                <th className="w-8">
                  <span className="sr-only">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, i) => (
                <tr
                  key={item.id}
                  className={`group border-t border-sp-line ${item.enabled ? '' : 'opacity-55'}`}
                >
                  <td className="text-center">
                    <ToggleField
                      checked={item.enabled}
                      onChange={(enabled) => update(item.id, { enabled })}
                      size="sm"
                      ariaLabel={`Enable field ${i + 1}`}
                    />
                  </td>
                  <td className="border-r border-sp-line/40">
                    <input
                      aria-label={`Field ${i + 1} key`}
                      value={item.key}
                      placeholder="key"
                      onChange={(e) => update(item.id, { key: e.target.value })}
                      className={inputClass}
                    />
                  </td>
                  <td>
                    <VariableInput
                      rawInput
                      aria-label={`Field ${i + 1} value`}
                      value={item.value}
                      placeholder="value"
                      onValueChange={(value) => update(item.id, { value })}
                      className={inputClass}
                    />
                  </td>
                  <td className="text-center">
                    <button
                      type="button"
                      aria-label={`Remove field ${i + 1}`}
                      onClick={() => onChange(items.filter((other) => other.id !== item.id))}
                      className="p-1 rounded-sp-btn text-sp-dim opacity-60 group-hover:opacity-100 hover:text-sp-text hover:bg-sp-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button
            type="button"
            onClick={() =>
              onChange([
                ...items,
                { id: uuidv4(), key: '', value: '', enabled: true, type: 'text' },
              ])
            }
            className="m-2 inline-flex items-center gap-1.5 rounded-sp-btn px-2 py-1 text-sp-12 text-sp-muted hover:text-sp-text hover:bg-sp-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden="true" />
            Add field
          </button>
        </div>
      )}
    </div>
  );
}
