import { X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useCollectionStore } from '@/store/useCollectionStore';
import type { CollectionItem, HttpRequest } from '@/types';
import { createResturaRequestTool } from '../lib/agentTools';
import { parseToolsJson, upsertTool } from '../lib/evalTools';
import type { AiToolDef } from '../types';

interface EvalToolsEditorProps {
  tools: AiToolDef[];
  onChange: (tools: AiToolDef[]) => void;
}

function collectHttpRequests(items: CollectionItem[], out: HttpRequest[] = []): HttpRequest[] {
  for (const item of items) {
    if (item.request?.type === 'http') out.push(item.request);
    if (item.items) collectHttpRequests(item.items, out);
  }
  return out;
}

const noExecute = () => Promise.reject(new Error('eval tools are offered, never executed'));

/**
 * Tool definitions offered to the model, which the tool-call scorer needs to
 * ever pass. Add from a saved HTTP request (same definition the Agent workbench
 * derives) or edit the raw JSON array of `{ name, description, inputSchema }`.
 */
export function EvalToolsEditor({ tools, onChange }: EvalToolsEditorProps) {
  const collections = useCollectionStore((state) => state.collections);
  const requests = useMemo(
    () => collections.flatMap((collection) => collectHttpRequests(collection.items ?? [])),
    [collections]
  );
  const [rawText, setRawText] = useState<string | null>(null);
  const [rawError, setRawError] = useState<string | null>(null);
  const editing = rawText !== null;

  const applyRaw = () => {
    const parsed = parseToolsJson(rawText ?? '');
    if (!parsed.ok) {
      setRawError(parsed.error);
      return;
    }
    onChange(parsed.tools);
    setRawText(null);
    setRawError(null);
  };

  return (
    <div className="space-y-1.5" data-testid="eval-tools-editor">
      <div className="flex items-center justify-between gap-2">
        <span className="sp-label">Tools</span>
        <div className="flex items-center gap-1.5">
          {requests.length > 0 && (
            <Select
              value=""
              onValueChange={(id) => {
                const request = requests.find((candidate) => candidate.id === id);
                if (request) {
                  onChange(
                    upsertTool(tools, createResturaRequestTool(request, noExecute).definition)
                  );
                }
              }}
            >
              <SelectTrigger className="w-44" aria-label="Add tool from saved request">
                <SelectValue placeholder="Add from request" />
              </SelectTrigger>
              <SelectContent>
                {requests.map((request) => (
                  <SelectItem key={request.id} value={request.id}>
                    {request.method} {request.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button
            variant="ghost"
            size="sm"
            data-testid="eval-tools-edit-json"
            onClick={() => {
              setRawText(editing ? null : JSON.stringify(tools, null, 2));
              setRawError(null);
            }}
          >
            {editing ? 'Cancel' : 'Edit JSON'}
          </Button>
        </div>
      </div>
      {editing ? (
        <div className="space-y-1.5">
          <Label htmlFor="eval-tools-json" className="sr-only">
            Tool definitions (JSON)
          </Label>
          <Textarea
            id="eval-tools-json"
            className="font-mono text-sp-13"
            rows={8}
            placeholder='[{"name":"lookup","description":"...","inputSchema":{"type":"object"}}]'
            value={rawText ?? ''}
            onChange={(event) => setRawText(event.target.value)}
          />
          {rawError && (
            <p role="alert" className="text-sp-11 text-destructive">
              {rawError}
            </p>
          )}
          <Button size="sm" data-testid="eval-tools-apply" onClick={applyRaw}>
            Apply tools
          </Button>
        </div>
      ) : tools.length === 0 ? (
        <p className="text-sp-11 text-sp-dim">
          No tools. The Tool call scorer needs at least one to ever pass.
        </p>
      ) : (
        <ul className="space-y-1">
          {tools.map((tool) => (
            <li
              key={tool.name}
              className="flex items-center justify-between gap-2 text-sp-12 text-sp-text"
            >
              <span className="min-w-0 truncate">
                <span className="font-mono">{tool.name}</span>
                {tool.description && <span className="text-sp-muted"> — {tool.description}</span>}
              </span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove tool ${tool.name}`}
                onClick={() => onChange(tools.filter((candidate) => candidate.name !== tool.name))}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
