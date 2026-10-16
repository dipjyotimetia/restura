import { ArrowDown, ArrowUp, Pencil, Plus, Send, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { TextField, VariableText } from '@/components/ui/spatial';
import {
  type MessageTemplateBase,
  moveTemplate,
  removeTemplate,
  renameTemplate,
} from '@/lib/shared/streaming/messageTemplates';

export interface MessageTemplateListProps<T extends MessageTemplateBase> {
  templates: readonly T[];
  /** Persist the edited list (create / rename / delete / reorder). */
  onChange: (next: T[]) => void;
  /** Copy a template into the composer. */
  onLoad: (template: T) => void;
  /** Send a template as-is (variables are resolved by the caller at send time). */
  onSend: (template: T) => void;
  /** Build a template from the composer's current contents (null = nothing to save). */
  createFromComposer: () => T | null;
  canSend: boolean;
  /** One-line summary under the name, e.g. format or topic. */
  describe: (template: T) => string;
  /** Singular noun for labels — "message", "emit", "publish". */
  noun: string;
  /** Plural for labels; defaults to `${noun}s`. */
  plural?: string;
}

const iconButton =
  'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sp-chip text-sp-muted hover:bg-sp-hover hover:text-sp-text disabled:opacity-40 disabled:pointer-events-none';

/**
 * Saved-template list shared by the WebSocket, Socket.IO and MQTT composers
 * (#974). Click a name (or Enter) to load it into the composer; the send
 * button or Shift+Enter sends it straight away.
 */
export function MessageTemplateList<T extends MessageTemplateBase>({
  templates,
  onChange,
  onLoad,
  onSend,
  createFromComposer,
  canSend,
  describe,
  noun,
  plural = `${noun}s`,
}: MessageTemplateListProps<T>) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');

  const startRename = (template: T) => {
    setEditingId(template.id);
    setDraftName(template.name);
  };
  const commitRename = () => {
    if (editingId) onChange(renameTemplate(templates, editingId, draftName));
    setEditingId(null);
  };
  const saveCurrent = () => {
    const created = createFromComposer();
    if (!created) return;
    onChange([...templates, created]);
    startRename(created);
  };

  return (
    <div className="flex flex-col gap-1" data-testid="message-template-list">
      <div className="flex items-center gap-2">
        <span className="sp-label">Saved {plural}</span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={saveCurrent}
          className="inline-flex h-6 items-center gap-1 rounded-sp-chip px-1.5 text-sp-11 text-sp-muted hover:bg-sp-hover hover:text-sp-text"
        >
          <Plus className="h-3 w-3" /> Save current
        </button>
      </div>
      {templates.length === 0 ? (
        <p className="py-1 text-sp-11 text-sp-dim">
          No saved {plural} yet — compose one and click Save current.
        </p>
      ) : (
        <ul className="flex max-h-36 flex-col gap-0.5 overflow-auto" aria-label={`Saved ${plural}`}>
          {templates.map((template, index) => (
            <li
              key={template.id}
              className="group flex items-center gap-1 rounded-sp-chip px-1 hover:bg-sp-hover"
            >
              {editingId === template.id ? (
                <TextField
                  size="sm"
                  autoFocus
                  value={draftName}
                  aria-label={`Rename saved ${noun}`}
                  onChange={(e) => setDraftName(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      commitRename();
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      setEditingId(null);
                    }
                  }}
                  className="flex-1"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => onLoad(template)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && e.shiftKey) {
                      e.preventDefault();
                      if (canSend) onSend(template);
                    }
                  }}
                  title={`Load into composer (Shift+Enter to send)`}
                  className="flex min-w-0 flex-1 flex-col items-start py-1 text-left"
                >
                  <span className="truncate text-sp-12 text-sp-text">{template.name}</span>
                  <span className="w-full truncate font-mono text-sp-11 text-sp-dim">
                    <VariableText text={describe(template)} />
                  </span>
                </button>
              )}
              <button
                type="button"
                className={iconButton}
                onClick={() => onSend(template)}
                disabled={!canSend}
                aria-label={`Send ${template.name}`}
                title="Send"
              >
                <Send className="h-3 w-3" />
              </button>
              <button
                type="button"
                className={iconButton}
                onClick={() => startRename(template)}
                aria-label={`Rename ${template.name}`}
                title="Rename"
              >
                <Pencil className="h-3 w-3" />
              </button>
              <button
                type="button"
                className={iconButton}
                onClick={() => onChange(moveTemplate(templates, template.id, -1))}
                disabled={index === 0}
                aria-label={`Move ${template.name} up`}
                title="Move up"
              >
                <ArrowUp className="h-3 w-3" />
              </button>
              <button
                type="button"
                className={iconButton}
                onClick={() => onChange(moveTemplate(templates, template.id, 1))}
                disabled={index === templates.length - 1}
                aria-label={`Move ${template.name} down`}
                title="Move down"
              >
                <ArrowDown className="h-3 w-3" />
              </button>
              <button
                type="button"
                className={iconButton}
                onClick={() => onChange(removeTemplate(templates, template.id))}
                aria-label={`Delete ${template.name}`}
                title="Delete"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default MessageTemplateList;
