import { Plus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { VariableInput } from '@/components/shared/VariableInput';
import {
  parseUrlEncoded,
  serializeUrlEncoded,
  type UrlEncodedField,
} from '@/features/http/lib/urlEncodedBody';

interface UrlEncodedEditorProps {
  raw: string;
  onChange: (raw: string) => void;
}

const inputClass =
  'w-full bg-transparent outline-none font-mono text-sp-12 text-sp-text placeholder:text-sp-dim px-2 py-1.5 focus:bg-sp-hover';

/** Key/value table over an x-www-form-urlencoded body (stored as the raw string). */
export default function UrlEncodedEditor({ raw, onChange }: UrlEncodedEditorProps) {
  const [rows, setRows] = useState<UrlEncodedField[]>(() => parseUrlEncoded(raw));

  // Re-read when the body changes from outside (paste in Text mode, tab switch).
  useEffect(() => {
    setRows((current) =>
      serializeUrlEncoded(current) === raw.trim() ? current : parseUrlEncoded(raw)
    );
  }, [raw]);

  const commit = (next: UrlEncodedField[]) => {
    setRows(next);
    onChange(serializeUrlEncoded(next));
  };

  return (
    <div className="h-full overflow-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr className="text-left text-sp-11 text-sp-dim">
            <th className="px-2 py-1.5 font-medium">Key</th>
            <th className="px-2 py-1.5 font-medium">Value</th>
            <th className="w-8">
              <span className="sr-only">Remove</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="group border-t border-sp-line">
              <td className="border-r border-sp-line/40">
                <input
                  aria-label={`Field ${i + 1} key`}
                  value={row.key}
                  placeholder="key"
                  onChange={(e) =>
                    commit(rows.map((r, j) => (j === i ? { ...r, key: e.target.value } : r)))
                  }
                  className={inputClass}
                />
              </td>
              <td>
                <VariableInput
                  rawInput
                  aria-label={`Field ${i + 1} value`}
                  value={row.value}
                  placeholder="value"
                  onValueChange={(value) =>
                    commit(rows.map((r, j) => (j === i ? { ...r, value } : r)))
                  }
                  className={inputClass}
                />
              </td>
              <td className="text-center">
                <button
                  type="button"
                  aria-label={`Remove field ${i + 1}`}
                  onClick={() => commit(rows.filter((_, j) => j !== i))}
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
        onClick={() => setRows([...rows, { key: '', value: '' }])}
        className="m-2 inline-flex items-center gap-1.5 rounded-sp-btn px-2 py-1 text-sp-12 text-sp-muted hover:text-sp-text hover:bg-sp-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent"
      >
        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
        Add field
      </button>
    </div>
  );
}
