import { isDestructiveTool, mcpToolDisplayName } from '@shared/protocol/mcp-tool-descriptor';
import { Play, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { TextField } from '@/components/ui/spatial';
import {
  McpArgumentField,
  type McpArgumentField as McpArgumentFieldType,
} from '@/features/mcp/components/McpArgumentField';
import { McpToolHintBadges } from '@/features/mcp/components/McpToolHintBadges';
import { parseMcpArgument } from '@/features/mcp/lib/mcpArgumentValidation';
import { generateMcpTemplate } from '@/features/mcp/lib/mcpClient';
import type { McpJsonSchema, McpPromptDescriptor, McpToolDescriptor } from '@/types';

export type McpInvokeTab = 'tools' | 'resources' | 'prompts' | 'log' | 'events';

interface McpInvokeFormProps {
  tab: McpInvokeTab;
  tool: McpToolDescriptor | null;
  prompt: McpPromptDescriptor | null;
  onCall: (tool: McpToolDescriptor, args: Record<string, unknown>) => Promise<void>;
  onGet: (prompt: McpPromptDescriptor, args: Record<string, string>) => Promise<void>;
  /**
   * Saved argument values for `tool` (from the tab's request). Seeds the form
   * when the tool loads; when undefined the schema template is used instead.
   */
  toolArguments?: Record<string, unknown> | undefined;
  /** Reports the current (best-effort parsed) tool arguments on every edit. */
  onToolArgumentsChange?: (args: Record<string, unknown>) => void;
  /** Saved argument values for `prompt`. */
  promptArguments?: Record<string, string> | undefined;
  /** Reports the current prompt arguments on every edit. */
  onPromptArgumentsChange?: (args: Record<string, string>) => void;
}

/** The invocation surface deliberately delegates transport work to the builder-owned client. */
export function McpInvokeForm({
  tab,
  tool,
  prompt,
  onCall,
  onGet,
  toolArguments,
  onToolArgumentsChange,
  promptArguments,
  onPromptArgumentsChange,
}: McpInvokeFormProps) {
  if (tab === 'tools')
    return (
      <InvokeToolForm
        tool={tool}
        onCall={onCall}
        initialArguments={toolArguments}
        onArgumentsChange={onToolArgumentsChange}
      />
    );
  if (tab === 'prompts')
    return (
      <InvokePromptForm
        prompt={prompt}
        onGet={onGet}
        initialArguments={promptArguments}
        onArgumentsChange={onPromptArgumentsChange}
      />
    );
  return <EmptyMcpInvokeForm tab={tab} />;
}

/**
 * Persistable view of the raw field strings: parsed where the value is valid
 * for its schema type, the raw string otherwise (so half-typed JSON survives a
 * save/reopen round-trip verbatim).
 */
function toPersistedArguments(
  fields: McpArgumentFieldType[],
  values: Record<string, string>
): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = values[field.name];
    if (raw === undefined || raw === '') continue;
    const parsed = parseMcpArgument(raw, field.type);
    args[field.name] = parsed.ok ? parsed.value : raw;
  }
  return args;
}

/**
 * Apply only the user-edited fields onto the saved arguments. Keys the current
 * tool schema doesn't declare (`additionalProperties`, CLI/OpenCollection
 * authored, or from an older schema) and untouched values — including saved
 * empty strings — survive verbatim. Clearing an edited field removes it.
 */
function mergeEditedArguments(
  saved: Record<string, unknown>,
  fields: McpArgumentFieldType[],
  values: Record<string, string>,
  edited: ReadonlySet<string>
): Record<string, unknown> {
  const args: Record<string, unknown> = { ...saved };
  for (const field of fields) {
    if (!edited.has(field.name)) continue;
    const raw = values[field.name];
    if (raw === undefined || raw === '') {
      delete args[field.name];
      continue;
    }
    const parsed = parseMcpArgument(raw, field.type);
    args[field.name] = parsed.ok ? parsed.value : raw;
  }
  return args;
}

function isArgumentRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function flattenMcpArgumentFields(
  schema: McpJsonSchema | undefined
): McpArgumentFieldType[] {
  if (!schema?.properties) return [];
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties).map(([name, sub]) => {
    const type = describeMcpSchemaType(sub);
    const field: McpArgumentFieldType = {
      name,
      type,
      required: required.has(name),
      isComplex: type === 'object' || type === 'array',
    };
    if (sub.description !== undefined) field.description = sub.description;
    return field;
  });
}

function describeMcpSchemaType(schema: McpJsonSchema | undefined): string {
  if (!schema?.type) return 'any';
  return Array.isArray(schema.type) ? schema.type.join('|') : schema.type;
}

function valueToString(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value, null, 2);
}

function InvokeToolForm({
  tool,
  onCall,
  initialArguments,
  onArgumentsChange,
}: {
  tool: McpToolDescriptor | null;
  onCall: (tool: McpToolDescriptor, args: Record<string, unknown>) => Promise<void>;
  initialArguments?: Record<string, unknown> | undefined;
  onArgumentsChange?: ((args: Record<string, unknown>) => void) | undefined;
}) {
  const fields = useMemo(() => flattenMcpArgumentFields(tool?.inputSchema), [tool]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [pendingArgs, setPendingArgs] = useState<Record<string, unknown> | null>(null);
  // Read through a ref so persisting an edit (which feeds back in as
  // `initialArguments`) never re-runs the seeding effect below.
  const initialArgumentsRef = useRef(initialArguments);
  initialArgumentsRef.current = initialArguments;
  // Saved arguments the form was seeded from, and the fields the user has
  // touched since. Edits are merged onto the saved object so restoring a
  // request never rewrites it: unknown keys and untouched values are kept.
  const savedArgumentsRef = useRef<Record<string, unknown> | undefined>(undefined);
  const editedFieldsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    savedArgumentsRef.current = undefined;
    editedFieldsRef.current = new Set();
    if (!tool) {
      setValues({});
      return;
    }
    const saved = initialArgumentsRef.current;
    if (isArgumentRecord(saved)) savedArgumentsRef.current = saved;
    const source: unknown = saved ?? generateMcpTemplate(tool.inputSchema);
    const next: Record<string, string> = {};
    if (isArgumentRecord(source)) {
      for (const field of fields) {
        next[field.name] = valueToString(source[field.name]);
      }
    }
    setValues(next);
    setValidationErrors({});
    // Seeding is not an edit: never report it, or reopening a saved request
    // would rewrite (and dirty) it. The template only persists once edited.
  }, [tool, fields]);

  const persistEdit = (fieldName: string, next: Record<string, string>) => {
    if (!onArgumentsChange) return;
    editedFieldsRef.current.add(fieldName);
    const saved = savedArgumentsRef.current;
    onArgumentsChange(
      saved
        ? mergeEditedArguments(saved, fields, next, editedFieldsRef.current)
        : toPersistedArguments(fields, next)
    );
  };

  const handleCall = async () => {
    if (!tool) return;
    const args: Record<string, unknown> = {};
    const nextErrors: Record<string, string> = {};
    for (const field of fields) {
      const raw = values[field.name];
      if (raw === undefined || raw === '') {
        if (field.required) nextErrors[field.name] = 'This field is required.';
        continue;
      }
      const parsed = parseMcpArgument(raw, field.type);
      if (!parsed.ok) {
        nextErrors[field.name] = parsed.error;
        continue;
      }
      args[field.name] = parsed.value;
    }
    if (Object.keys(nextErrors).length > 0) {
      console.warn('MCP tool argument validation failed', {
        fields: Object.keys(nextErrors),
        toolName: tool.name,
      });
      setValidationErrors(nextErrors);
      return;
    }
    setValidationErrors({});
    // Hints are untrusted, but an explicit destructiveHint is still worth a
    // speed bump before the call leaves the client.
    if (isDestructiveTool(tool)) {
      setPendingArgs(args);
      return;
    }
    await runCall(tool, args);
  };

  const runCall = async (target: McpToolDescriptor, args: Record<string, unknown>) => {
    setRunning(true);
    try {
      await onCall(target, args);
    } finally {
      setRunning(false);
    }
  };

  if (!tool) return <EmptyMcpInvokeForm tab="tools" />;

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between gap-2 px-3 h-10 border-b border-sp-line shrink-0">
        <InvokeTitle name={mcpToolDisplayName(tool)} />
        <Button
          variant="glow"
          size="sm"
          onClick={handleCall}
          loading={running}
          className="h-7 px-3 text-sp-12 rounded-sp-btn"
        >
          <Play className="h-3.5 w-3.5" />
          Invoke
        </Button>
      </div>
      <ScrollArea className="flex-1 min-h-0">
        <div className="p-3 space-y-3">
          <McpToolHintBadges tool={tool} />
          {tool.description && <p className="text-sp-12 text-sp-muted">{tool.description}</p>}
          {fields.length === 0 ? (
            <div className="text-sp-12 text-sp-dim italic">This tool takes no arguments.</div>
          ) : (
            fields.map((field) => (
              <McpArgumentField
                key={field.name}
                field={field}
                value={values[field.name] ?? ''}
                error={validationErrors[field.name]}
                onChange={(value) => {
                  const next = { ...values, [field.name]: value };
                  setValues(next);
                  persistEdit(field.name, next);
                  setValidationErrors((current) => {
                    if (current[field.name] === undefined) return current;
                    const { [field.name]: _removed, ...remaining } = current;
                    return remaining;
                  });
                }}
              />
            ))
          )}
        </div>
      </ScrollArea>
      <ConfirmDialog
        open={pendingArgs !== null}
        onOpenChange={(open) => {
          if (!open) setPendingArgs(null);
        }}
        title={`Invoke destructive tool "${mcpToolDisplayName(tool)}"?`}
        description="This server marks the tool as destructive (it may modify or delete data). Hints come from the server and are not verified. Continue only if you trust this server."
        confirmText="Invoke"
        variant="destructive"
        onConfirm={() => {
          const args = pendingArgs;
          setPendingArgs(null);
          if (args) void runCall(tool, args);
        }}
      />
    </div>
  );
}

function InvokePromptForm({
  prompt,
  onGet,
  initialArguments,
  onArgumentsChange,
}: {
  prompt: McpPromptDescriptor | null;
  onGet: (prompt: McpPromptDescriptor, args: Record<string, string>) => Promise<void>;
  initialArguments?: Record<string, string> | undefined;
  onArgumentsChange?: ((args: Record<string, string>) => void) | undefined;
}) {
  const [args, setArgs] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const initialArgumentsRef = useRef(initialArguments);
  initialArgumentsRef.current = initialArguments;

  const promptName = prompt?.name;
  useEffect(() => {
    setArgs(promptName !== undefined ? (initialArgumentsRef.current ?? {}) : {});
  }, [promptName]);

  if (!prompt) return <EmptyMcpInvokeForm tab="prompts" />;
  const fields = prompt.arguments ?? [];

  const handleGet = async () => {
    setRunning(true);
    try {
      await onGet(prompt, args);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between gap-2 px-3 h-10 border-b border-sp-line shrink-0">
        <InvokeTitle name={prompt.name} />
        <Button
          variant="glow"
          size="sm"
          onClick={handleGet}
          loading={running}
          className="h-7 px-3 text-sp-12 rounded-sp-btn"
        >
          <Play className="h-3.5 w-3.5" />
          Invoke
        </Button>
      </div>
      <ScrollArea className="flex-1 min-h-0">
        <div className="p-3 space-y-3">
          {prompt.description && <p className="text-sp-12 text-sp-muted">{prompt.description}</p>}
          {fields.length === 0 ? (
            <div className="text-sp-12 text-sp-dim italic">This prompt takes no arguments.</div>
          ) : (
            fields.map((argument) => (
              <div key={argument.name} className="space-y-1.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono font-bold text-sp-12 text-sp-text">
                    {argument.name}
                  </span>
                  <span className="font-mono text-sp-11 text-sp-dim">string</span>
                  {argument.required && (
                    <span
                      className="inline-flex items-center px-1.5 h-4 rounded-[5px] font-mono font-bold text-sp-9 tracking-wider"
                      style={{
                        color: 'var(--color-danger)',
                        background: 'color-mix(in srgb, var(--color-danger) 14%, transparent)',
                      }}
                    >
                      REQUIRED
                    </span>
                  )}
                </div>
                {argument.description && (
                  <div className="text-sp-11-5 text-sp-muted">{argument.description}</div>
                )}
                <TextField
                  mono
                  value={args[argument.name] ?? ''}
                  onChange={(event) => {
                    const next = { ...args, [argument.name]: event.target.value };
                    setArgs(next);
                    onArgumentsChange?.(next);
                  }}
                  placeholder=""
                  className="w-full"
                />
              </div>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function InvokeTitle({ name }: { name: string }) {
  return (
    <div className="min-w-0 flex items-center gap-2">
      <Sparkles className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--color-warning)' }} />
      <span
        className="font-mono font-bold text-sp-13 truncate"
        style={{ color: 'var(--sp-accent)' }}
      >
        {name}
      </span>
    </div>
  );
}

function EmptyMcpInvokeForm({ tab }: { tab: McpInvokeTab }) {
  const hint =
    tab === 'resources'
      ? 'Select a resource from the list and press Read.'
      : tab === 'log'
        ? 'The latest call appears in the Result panel.'
        : tab === 'events'
          ? 'Server notifications stream into the Events list.'
          : 'Pick a tool or prompt.';
  return (
    <div className="flex-1 grid place-items-center">
      <div className="text-center text-sp-muted text-sp-12">{hint}</div>
    </div>
  );
}
