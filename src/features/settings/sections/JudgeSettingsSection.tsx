import { isLocalProvider, type Provider } from '@shared/protocol/ai/types';
import { KeyRound, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Segmented, TextField, ToggleField } from '@/components/ui/spatial';
import { getElectronAPI } from '@/lib/shared/platform';
import { cn } from '@/lib/shared/utils';
import { useSettingsStore } from '@/store/useSettingsStore';
import { DEFAULT_JUDGE_SETTINGS } from '@/types';
import { FieldGroup, FieldRow } from '../components/SettingsSectionPrimitives';

const JUDGE_PROVIDERS: ReadonlyArray<{ value: Provider; label: string }> = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'ollama', label: 'Ollama' },
  { value: 'openai-compatible', label: 'Compatible' },
];

export function JudgeSettingsSection() {
  const judge = useSettingsStore((state) => state.settings.judge) ?? DEFAULT_JUDGE_SETTINGS;
  const updateJudge = useSettingsStore((state) => state.updateJudge);
  const isLocal = isLocalProvider(judge.provider);
  const [pendingKey, setPendingKey] = useState('');
  const saveJudgeKey = async () => {
    const value = pendingKey.trim();
    if (!value) return;
    const api = getElectronAPI()?.secrets;
    if (!api) return;
    const result = await api.store({ scope: 'ai:judge', value, label: 'judge key' });
    if (!result.ok) {
      toast.error(`Failed to store key: ${result.error}`);
      return;
    }
    updateJudge({ apiKeyHandleId: result.id });
    setPendingKey('');
    toast.success('Judge API key stored');
  };
  const clearJudgeKey = async () => {
    const api = getElectronAPI()?.secrets;
    if (judge.apiKeyHandleId && api) await api.delete(judge.apiKeyHandleId);
    updateJudge({ apiKeyHandleId: undefined });
  };

  return (
    <FieldGroup label="Semantic assertions (rs.judge)">
      <FieldRow
        label="Enable LLM judge"
        hint="Lets test scripts call rs.judge(output, { rubric }) to assert on response meaning."
        control={
          <ToggleField
            checked={judge.enabled}
            onChange={(value) => updateJudge({ enabled: value })}
            ariaLabel="Enable LLM judge"
          />
        }
      />
      <FieldRow
        label="Judge provider"
        control={
          <Segmented<Provider>
            value={judge.provider}
            onChange={(value) => updateJudge({ provider: value })}
            options={JUDGE_PROVIDERS}
          />
        }
      />
      <FieldRow
        label="Judge model"
        hint="e.g. gpt-4o-mini, claude-3-5-haiku, or a local Ollama model."
        control={
          <TextField
            mono
            placeholder="gpt-4o-mini"
            value={judge.model}
            onChange={(event) => updateJudge({ model: event.target.value })}
            disabled={!judge.enabled}
            className="w-[260px]"
          />
        }
      />
      {isLocal && (
        <FieldRow
          label="Base URL"
          hint="Required for local runtimes (e.g. http://localhost:11434)."
          control={
            <TextField
              mono
              placeholder="http://localhost:11434"
              value={judge.baseUrl ?? ''}
              onChange={(event) => updateJudge({ baseUrl: event.target.value })}
              disabled={!judge.enabled}
              className="w-[260px]"
            />
          }
        />
      )}
      <FieldRow
        label="API key"
        hint={
          isLocal
            ? 'Optional for local runtimes (only if your gateway requires auth).'
            : 'Required for cloud providers. Stored in the OS keychain; the renderer never sees it.'
        }
        control={
          judge.apiKeyHandleId ? (
            <div className="flex items-center gap-2">
              <span className="text-sp-12 font-mono text-sp-muted">
                handle {judge.apiKeyHandleId.slice(0, 8)}…
              </span>
              <JudgeAction icon={Trash2} danger onClick={() => void clearJudgeKey()}>
                Clear
              </JudgeAction>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <TextField
                type="password"
                mono
                placeholder="sk-…"
                value={pendingKey}
                onChange={(event) => setPendingKey(event.target.value)}
                disabled={!judge.enabled}
                className="w-[200px]"
              />
              <JudgeAction
                icon={KeyRound}
                disabled={!judge.enabled || !pendingKey.trim()}
                onClick={() => void saveJudgeKey()}
              >
                Save
              </JudgeAction>
            </div>
          )
        }
      />
      <FieldRow
        label="Redact before judging"
        hint="Strip secret-looking tokens from the response before it is sent to the judge. For sensitive APIs, prefer a local Ollama judge so responses never leave your machine."
        control={
          <ToggleField
            checked={judge.redactBeforeJudge}
            onChange={(value) => updateJudge({ redactBeforeJudge: value })}
            ariaLabel="Redact before judging"
          />
        }
      />
    </FieldGroup>
  );
}

function JudgeAction({
  icon: Icon,
  danger,
  ...props
}: {
  icon: typeof KeyRound;
  danger?: boolean;
  onClick: () => void;
  disabled?: boolean;
  children: string;
}) {
  return (
    <button
      type="button"
      {...props}
      className={cn(
        'inline-flex items-center gap-1.5 h-8 px-2.5 rounded-sp-btn text-sp-12 font-medium border transition-colors',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent disabled:opacity-50 disabled:cursor-not-allowed',
        danger
          ? 'border-rose-500/30 bg-rose-500/5 text-rose-500 dark:text-rose-400 hover:bg-rose-500/10 hover:border-rose-400/60'
          : 'border-sp-line bg-sp-surface text-sp-text hover:bg-sp-hover'
      )}
    >
      <Icon size={12} aria-hidden="true" />
      {props.children}
    </button>
  );
}
