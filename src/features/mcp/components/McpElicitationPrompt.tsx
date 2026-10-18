import { ELICITATION_FORM_ERROR_KEY } from '@shared/protocol/mcp-elicitation';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { McpArgumentField } from '@/features/mcp/components/McpArgumentField';
import type {
  McpClientRespondResult,
  McpElicitationResponse,
} from '@/features/mcp/lib/mcpClientRequests';
import {
  buildElicitationContent,
  buildElicitationForm,
} from '@/features/mcp/lib/mcpElicitationForm';

interface McpElicitationPromptProps {
  params: unknown;
  onRespond: (response: McpElicitationResponse) => Promise<McpClientRespondResult>;
}

/**
 * Form-mode elicitation (#860): a schema-driven form built from the server's
 * `requestedSchema`. Accept submits validated content; Decline and Cancel send
 * the matching spec action with no content.
 */
export function McpElicitationPrompt({ params, onRespond }: McpElicitationPromptProps) {
  const p = (params && typeof params === 'object' ? params : {}) as {
    message?: unknown;
    requestedSchema?: unknown;
  };
  const message = typeof p.message === 'string' ? p.message : 'The server is requesting input.';
  const form = useMemo(() => buildElicitationForm(p.requestedSchema), [p.requestedSchema]);
  const [values, setValues] = useState<Record<string, string>>(() => form?.initialValues ?? {});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const send = async (response: McpElicitationResponse) => {
    setBusy(true);
    const result = await onRespond(response);
    setBusy(false);
    if (!result.ok) {
      setErrors(result.fieldErrors ?? { [ELICITATION_FORM_ERROR_KEY]: result.error });
    }
  };

  const accept = () => {
    if (!form) return;
    const content = buildElicitationContent(p.requestedSchema, form.fields, values);
    if (!content.ok) {
      setErrors(content.errors);
      return;
    }
    setErrors({});
    void send({ action: 'accept', content: content.content });
  };

  const formError = errors[ELICITATION_FORM_ERROR_KEY];

  return (
    <form
      className="space-y-4"
      // Enter in a field must never accept: submitting is an explicit click only.
      onSubmit={(event) => event.preventDefault()}
    >
      <div
        className="max-h-[20vh] overflow-y-auto rounded-sp-btn border border-sp-line bg-sp-surface-lo px-3 py-2"
        aria-label="Server message"
      >
        <p className="text-sp-13 text-sp-text whitespace-pre-wrap break-words">{message}</p>
      </div>
      {form ? (
        <div className="space-y-3 max-h-[50vh] overflow-y-auto pr-1">
          {form.fields.map((field) => (
            <McpArgumentField
              key={field.name}
              field={field}
              value={values[field.name] ?? ''}
              {...(errors[field.name] ? { error: errors[field.name] } : {})}
              onChange={(value) => setValues((current) => ({ ...current, [field.name]: value }))}
            />
          ))}
        </div>
      ) : (
        <p className="text-sp-12 text-rose-400" role="alert">
          The server sent an unsupported form schema. Decline or cancel this request.
        </p>
      )}
      {formError && (
        <p className="text-sp-12 text-rose-400" role="alert">
          {formError}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => void send({ action: 'cancel' })}
        >
          Cancel
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          data-mcp-autofocus
          onClick={() => void send({ action: 'decline' })}
        >
          Decline
        </Button>
        <Button type="button" variant="cta" size="cta" disabled={busy || !form} onClick={accept}>
          Accept
        </Button>
      </div>
    </form>
  );
}
