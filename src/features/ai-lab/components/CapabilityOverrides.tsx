import type { ModelCapabilities } from '@shared/agent-lab';
import { SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  capabilitiesForDesktopModel,
  normalizeDesktopCapabilities,
} from '../lib/agentModelCapabilities';
import type { AiLabProviderConfig } from '../types';

const BOOLEAN_CAPABILITIES: Array<{
  key: keyof Pick<ModelCapabilities, 'toolCalling' | 'parallelToolCalls'>;
  label: string;
}> = [
  { key: 'toolCalling', label: 'Tool calling' },
  { key: 'parallelToolCalls', label: 'Parallel tool calls' },
];

interface CapabilityEdit {
  model: string;
  draft: ModelCapabilities;
  assertionConfirmed: boolean;
}

export function CapabilityOverrides({
  config,
  onUpdateProvider,
}: {
  config: AiLabProviderConfig;
  onUpdateProvider: (id: string, patch: Partial<AiLabProviderConfig>) => void;
}) {
  const [capabilityEditing, setCapabilityEditing] = useState<CapabilityEdit | null>(null);
  const [costAssertionConfirmed, setCostAssertionConfirmed] = useState(false);
  const [costEditing, setCostEditing] = useState(false);

  const startCapabilityEdit = (model: string) => {
    const resolved = capabilitiesForDesktopModel(config, model).capabilities;
    setCapabilityEditing({
      model,
      draft: {
        ...resolved,
        inputModalities: [...resolved.inputModalities],
        outputModalities: [...resolved.outputModalities],
        serverTools: [...resolved.serverTools],
      },
      assertionConfirmed: false,
    });
  };

  const saveCapabilityOverride = () => {
    if (!capabilityEditing?.assertionConfirmed) return;
    onUpdateProvider(config.id, {
      capabilityOverrides: {
        ...config.capabilityOverrides,
        [capabilityEditing.model]: normalizeDesktopCapabilities(capabilityEditing.draft),
      },
    });
    setCapabilityEditing(null);
  };

  const resetCapabilityOverride = (model: string) => {
    const next = { ...config.capabilityOverrides };
    delete next[model];
    onUpdateProvider(config.id, {
      capabilityOverrides: Object.keys(next).length ? next : undefined,
    });
    setCapabilityEditing(null);
  };

  const setCapabilityBoolean = (
    key: (typeof BOOLEAN_CAPABILITIES)[number]['key'],
    checked: boolean
  ) =>
    setCapabilityEditing((current) => {
      if (!current) return current;
      return {
        ...current,
        draft: {
          ...current.draft,
          [key]: checked,
          ...(key === 'toolCalling' && !checked ? { parallelToolCalls: false } : {}),
        },
      };
    });

  return (
    <>
      {config.isLocal && (
        <div className="mt-2 space-y-2 border-t border-sp-line pt-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5 text-sp-10 font-medium text-sp-muted">
              <SlidersHorizontal className="h-3 w-3" /> Advanced cost classification
              {config.costPolicy === 'local-zero' && (
                <Badge variant="warning">local zero asserted</Badge>
              )}
            </div>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Configure cost classification"
              onClick={() => {
                setCostEditing((current) => !current);
                setCostAssertionConfirmed(false);
              }}
            >
              Configure
            </Button>
          </div>
          {costEditing && (
            <div className="space-y-2 rounded border border-sp-line p-2">
              <p className="text-sp-10 text-sp-muted">
                Cost stays unknown unless you explicitly confirm this endpoint runs locally without
                usage charges.
              </p>
              <label
                htmlFor={`cost-${config.id}-local-zero`}
                className="flex items-start gap-2 text-sp-10 text-sp-text"
              >
                <Checkbox
                  id={`cost-${config.id}-local-zero`}
                  aria-label="I assert this provider runs locally at zero cost"
                  checked={costAssertionConfirmed}
                  onCheckedChange={(checked) => setCostAssertionConfirmed(checked === true)}
                />
                <span>I assert this provider runs locally at zero cost</span>
              </label>
              <div className="flex flex-wrap gap-1">
                <Button
                  size="sm"
                  aria-label="Assert local zero cost"
                  disabled={!costAssertionConfirmed}
                  onClick={() => {
                    onUpdateProvider(config.id, { costPolicy: 'local-zero' });
                    setCostEditing(false);
                  }}
                >
                  Assert local zero
                </Button>
                {config.costPolicy === 'local-zero' && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      onUpdateProvider(config.id, { costPolicy: 'unknown' });
                      setCostEditing(false);
                    }}
                  >
                    Reset cost to unknown
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={() => setCostEditing(false)}>
                  Close
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {config.models.length > 0 && (
        <div className="mt-2 space-y-1.5 border-t border-sp-line pt-2">
          <div className="flex items-center gap-1.5 text-sp-10 font-medium text-sp-muted">
            <SlidersHorizontal className="h-3 w-3" /> Advanced model capabilities
          </div>
          {config.models.map((model) => {
            const asserted = config.capabilityOverrides?.[model] !== undefined;
            const editorOpen = capabilityEditing?.model === model;
            return (
              <div key={model} className="rounded border border-sp-line p-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-sp-10 text-sp-text" title={model}>
                    {config.modelDetails?.[model]?.label ?? model}
                  </span>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {asserted && <Badge variant="warning">user asserted</Badge>}
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Configure ${model} capabilities`}
                      onClick={() =>
                        editorOpen ? setCapabilityEditing(null) : startCapabilityEdit(model)
                      }
                    >
                      Configure
                    </Button>
                  </div>
                </div>

                {editorOpen && capabilityEditing && (
                  <div className="mt-2 space-y-3 border-t border-sp-line pt-2">
                    <p className="text-sp-10 text-sp-muted">
                      Starts from discovered metadata, or the conservative text-only default when
                      discovery did not verify a feature.
                    </p>
                    <p className="text-sp-10 text-sp-muted">
                      The desktop transport currently supports text and tool calling only. Media
                      input/output, structured output, reasoning controls, continuation, and server
                      tools cannot be asserted here.
                    </p>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {BOOLEAN_CAPABILITIES.map(({ key, label }) => {
                        const id = `cap-${config.id}-${model}-${key}`;
                        return (
                          <label
                            key={key}
                            htmlFor={id}
                            className="flex items-center gap-2 text-sp-10 text-sp-text"
                          >
                            <Checkbox
                              id={id}
                              checked={capabilityEditing.draft[key]}
                              disabled={
                                key === 'parallelToolCalls' && !capabilityEditing.draft.toolCalling
                              }
                              onCheckedChange={(value) => setCapabilityBoolean(key, value === true)}
                            />
                            {label}
                          </label>
                        );
                      })}
                    </div>
                    <label
                      htmlFor={`cap-${config.id}-${model}-assertion`}
                      className="flex items-start gap-2 text-sp-10 text-sp-text"
                    >
                      <Checkbox
                        id={`cap-${config.id}-${model}-assertion`}
                        aria-label="I am asserting this model supports these features"
                        checked={capabilityEditing.assertionConfirmed}
                        onCheckedChange={(checked) =>
                          setCapabilityEditing((current) =>
                            current ? { ...current, assertionConfirmed: checked === true } : current
                          )
                        }
                      />
                      <span>I am asserting this model supports these features</span>
                    </label>
                    <div className="flex flex-wrap gap-1">
                      <Button
                        size="sm"
                        aria-label="Save capability override"
                        disabled={!capabilityEditing.assertionConfirmed}
                        onClick={saveCapabilityOverride}
                      >
                        Save override
                      </Button>
                      {asserted && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => resetCapabilityOverride(model)}
                        >
                          Reset to discovered defaults
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label="Close capability editor"
                        onClick={() => setCapabilityEditing(null)}
                      >
                        Close
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
