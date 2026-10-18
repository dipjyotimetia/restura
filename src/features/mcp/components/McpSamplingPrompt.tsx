import { Sparkles } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { CodeEditorFrame, TextField } from '@/components/ui/spatial';
import type {
  McpClientRespondResult,
  McpSamplingResponse,
} from '@/features/mcp/lib/mcpClientRequests';
import {
  describeSamplingRequest,
  draftSamplingWithAi,
  samplingDraftProvider,
} from '@/features/mcp/lib/mcpSamplingDraft';

interface McpSamplingPromptProps {
  params: unknown;
  onRespond: (response: McpSamplingResponse) => Promise<McpClientRespondResult>;
}

const MANUAL_MODEL = 'restura-manual';

/**
 * Sampling approval (#860). Human-in-the-loop per spec: the request is shown in
 * full and nothing is returned to the server until the user explicitly
 * approves the (editable) response. An AI-provider draft only pre-fills it.
 */
export function McpSamplingPrompt({ params, onRespond }: McpSamplingPromptProps) {
  const view = useMemo(() => describeSamplingRequest(params), [params]);
  const provider = useMemo(() => samplingDraftProvider(), []);
  const [text, setText] = useState('');
  const [model, setModel] = useState(MANUAL_MODEL);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const draftAbortRef = useRef<AbortController | null>(null);

  // Stop an in-flight provider draft when the prompt settles or unmounts.
  useEffect(() => () => draftAbortRef.current?.abort(), []);

  const send = async (response: McpSamplingResponse) => {
    draftAbortRef.current?.abort();
    setBusy(true);
    const result = await onRespond(response);
    setBusy(false);
    if (!result.ok) setError(result.error);
  };

  const draft = async () => {
    draftAbortRef.current?.abort();
    const controller = new AbortController();
    draftAbortRef.current = controller;
    setDrafting(true);
    setError(null);
    const result = await draftSamplingWithAi(view, setText, controller.signal);
    if (controller.signal.aborted) return;
    setDrafting(false);
    if (result.ok) {
      setText(result.text);
      setModel(result.model);
    } else {
      setError(result.error);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sp-11-5 text-sp-muted font-mono">
        {view.maxTokens !== undefined && <span>maxTokens: {view.maxTokens}</span>}
        {view.temperature !== undefined && <span>temperature: {view.temperature}</span>}
        {view.includeContext && <span>includeContext: {view.includeContext}</span>}
        {view.modelHints.length > 0 && <span>model hints: {view.modelHints.join(', ')}</span>}
        {view.priorities.map((priority) => (
          <span key={priority.label}>
            {priority.label}: {priority.value}
          </span>
        ))}
      </div>

      <div className="space-y-2 max-h-[40vh] overflow-y-auto pr-1" aria-label="Sampling messages">
        {view.systemPrompt && <SamplingMessage role="system" text={view.systemPrompt} />}
        {view.messages.map((message, index) => (
          <SamplingMessage key={index} role={message.role} text={message.text} />
        ))}
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="sp-label">Response</span>
          {provider && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={drafting || busy}
              onClick={() => void draft()}
              title={`Draft with ${provider.provider} / ${provider.model}`}
            >
              <Sparkles className="h-3.5 w-3.5" />
              {drafting ? 'Drafting…' : `Draft with ${provider.model}`}
            </Button>
          )}
        </div>
        <CodeEditorFrame gutter={false} className="min-h-[100px]">
          <textarea
            aria-label="Sampling response"
            value={text}
            onChange={(event) => setText(event.target.value)}
            spellCheck={false}
            className="w-full h-full min-h-[100px] bg-transparent outline-none resize-y font-mono text-sp-12 text-sp-text placeholder:text-sp-dim"
            placeholder="Write the assistant response to return to the server"
          />
        </CodeEditorFrame>
        <label className="flex items-center gap-2 text-sp-12 text-sp-muted">
          Model
          <TextField
            mono
            size="sm"
            aria-label="Response model"
            value={model}
            onChange={(event) => setModel(event.target.value)}
            className="flex-1"
          />
        </label>
      </div>

      {error && (
        <p className="text-sp-12 text-rose-400" role="alert">
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          data-mcp-autofocus
          onClick={() => void send({ action: 'reject' })}
        >
          Reject
        </Button>
        <Button
          type="button"
          variant="cta"
          size="cta"
          disabled={busy || drafting || !text.trim() || !model.trim()}
          onClick={() => void send({ action: 'approve', text, model: model.trim() })}
        >
          Approve &amp; send
        </Button>
      </div>
    </div>
  );
}

function SamplingMessage({ role, text }: { role: string; text: string }) {
  return (
    <div className="rounded-sp-btn border border-sp-line bg-sp-surface-lo px-3 py-2">
      <div className="sp-label mb-1">{role}</div>
      <div className="text-sp-12 text-sp-text whitespace-pre-wrap break-words font-mono">
        {text}
      </div>
    </div>
  );
}
