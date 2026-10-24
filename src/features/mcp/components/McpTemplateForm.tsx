import { Play } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { McpArgumentField } from '@/features/mcp/components/McpArgumentField';
import {
  expandUriTemplate,
  getUriTemplateVariables,
  isOptionalUriTemplateVariable,
} from '@/features/mcp/lib/uriTemplate';
import type { McpResourceTemplateDescriptor } from '@/types';

interface McpTemplateFormProps {
  template: McpResourceTemplateDescriptor | null;
  /** Reads the fully expanded resource URI. */
  onRead: (uri: string) => Promise<void>;
  /**
   * `completion/complete` for a template variable (`ref/resource`); omitted
   * when the server lacks the `completions` capability.
   */
  onComplete?: (
    uriTemplate: string,
    argument: { name: string; value: string },
    context: Record<string, string>
  ) => Promise<string[]>;
}

/** URI-template parameter form: one field per variable, live preview, Read of the expanded URI. */
export function McpTemplateForm({ template, onRead, onComplete }: McpTemplateFormProps) {
  const uriTemplate = template?.uriTemplate;
  const names = useMemo(
    () => (uriTemplate ? getUriTemplateVariables(uriTemplate) : []),
    [uriTemplate]
  );
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);

  // Switching templates starts from a blank form.
  useEffect(() => {
    setValues({});
    setErrors({});
  }, [uriTemplate]);

  if (!template || !uriTemplate) {
    return (
      <div className="flex-1 grid place-items-center">
        <div className="text-center text-sp-muted text-sp-12">
          Select a resource template to fill in its parameters.
        </div>
      </div>
    );
  }

  const provided = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== ''));
  const preview = expandUriTemplate(uriTemplate, provided);

  const handleRead = async () => {
    const nextErrors: Record<string, string> = {};
    for (const name of names) {
      if (!values[name] && !isOptionalUriTemplateVariable(uriTemplate, name)) {
        nextErrors[name] = 'This field is required.';
      }
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    setRunning(true);
    try {
      await onRead(preview);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between gap-2 px-3 h-10 border-b border-sp-line shrink-0">
        <span
          className="font-mono font-bold text-sp-13 truncate"
          style={{ color: 'var(--sp-accent)' }}
        >
          {template.name}
        </span>
        <Button
          variant="glow"
          size="sm"
          onClick={handleRead}
          loading={running}
          className="h-7 px-3 text-sp-12 rounded-sp-btn"
        >
          <Play className="h-3.5 w-3.5" />
          Read
        </Button>
      </div>
      <ScrollArea className="flex-1 min-h-0">
        <div className="p-3 space-y-3">
          {template.description && (
            <p className="text-sp-12 text-sp-muted">{template.description}</p>
          )}
          <div className="space-y-1">
            <div className="sp-label">URI</div>
            <code
              data-testid="mcp-template-preview"
              className="block font-mono text-sp-12 text-sp-text break-all"
            >
              {preview}
            </code>
          </div>
          {names.length === 0 ? (
            <div className="text-sp-12 text-sp-dim italic">This template has no parameters.</div>
          ) : (
            names.map((name) => (
              <McpArgumentField
                key={name}
                field={{
                  name,
                  type: 'string',
                  required: !isOptionalUriTemplateVariable(uriTemplate, name),
                  isComplex: false,
                }}
                value={values[name] ?? ''}
                error={errors[name]}
                onChange={(value) => {
                  setValues((current) => ({ ...current, [name]: value }));
                  setErrors((current) => {
                    const { [name]: _removed, ...rest } = current;
                    return rest;
                  });
                }}
                complete={
                  onComplete
                    ? (value) => {
                        const { [name]: _self, ...context } = provided;
                        return onComplete(uriTemplate, { name, value }, context);
                      }
                    : undefined
                }
              />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
