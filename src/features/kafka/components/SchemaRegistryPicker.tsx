import { RefreshCw, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { KafkaSubjectSelection } from '@/features/kafka/lib/kafkaManager';
import { formatSchemaText, generateSchemaExample } from '@/features/kafka/lib/schemaExample';
import { getElectronAPI } from '@/lib/shared/platform';
import { cn } from '@/lib/shared/utils';
import type { KafkaRegistrySchemaIpc } from '../../../../electron/types/electron-api';

type SchemaSource = 'none' | 'subject' | 'id';

export interface SchemaRegistryFieldPickerProps {
  field: 'key' | 'value';
  connectionId: string;
  connected: boolean;
  topic: string;
  schemaId: string;
  onSchemaIdChange: (value: string) => void;
  subject: KafkaSubjectSelection | null;
  onSubjectChange: (value: KafkaSubjectSelection | null) => void;
  /** Receives a pretty-printed JSON example generated from the selected schema. */
  onGenerateExample: (json: string) => void;
}

const MAX_VISIBLE_SUBJECTS = 100;

/**
 * Schema Registry selection for one produce field (#926, #982): pick a subject
 * (filtered to `<topic>-key` / `<topic>-value` by default) and a version or
 * "latest" — the main process resolves it to a schema ID at send time — or
 * fall back to a raw numeric schema ID. Shows the selected schema read-only and
 * can generate an example payload for Avro and JSON Schema.
 */
export function SchemaRegistryFieldPicker({
  field,
  connectionId,
  connected,
  topic,
  schemaId,
  onSchemaIdChange,
  subject,
  onSubjectChange,
  onGenerateExample,
}: SchemaRegistryFieldPickerProps) {
  const label = field === 'key' ? 'Key' : 'Value';
  const defaultSubject = topic ? `${topic}-${field}` : '';
  const [source, setSource] = useState<SchemaSource>(
    subject ? 'subject' : schemaId.trim() ? 'id' : 'none'
  );
  const [query, setQuery] = useState(subject?.subject ?? defaultSubject);
  const [subjects, setSubjects] = useState<string[] | null>(null);
  const [versions, setVersions] = useState<number[]>([]);
  const [schema, setSchema] = useState<KafkaRegistrySchemaIpc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exampleError, setExampleError] = useState<string | null>(null);
  const api = getElectronAPI()?.kafka;

  const loadSubjects = useCallback(async () => {
    if (!api) return;
    setError(null);
    const result = await api.registryListSubjects({ connectionId });
    if (result.success) setSubjects(result.subjects ?? []);
    else setError(result.error ?? 'Could not list subjects.');
  }, [api, connectionId]);

  useEffect(() => {
    if (source === 'subject' && connected && subjects === null) void loadSubjects();
  }, [source, connected, subjects, loadSubjects]);

  // Pre-select the conventional `<topic>-<field>` subject once it is known to exist.
  useEffect(() => {
    if (source === 'subject' && !subject && subjects?.includes(defaultSubject)) {
      onSubjectChange({ subject: defaultSubject, version: 'latest' });
    }
  }, [source, subject, subjects, defaultSubject, onSubjectChange]);

  const selectedSubject = subject?.subject;
  const selectedVersion = subject?.version;
  useEffect(() => {
    setVersions([]);
    setSchema(null);
    setExampleError(null);
    if (!api || !connected || source !== 'subject' || !selectedSubject) return;
    let stale = false;
    void (async () => {
      const [versionResult, schemaResult] = await Promise.all([
        api.registryListVersions({ connectionId, subject: selectedSubject }),
        api.registryGetSchema({
          connectionId,
          subject: selectedSubject,
          version: selectedVersion ?? 'latest',
        }),
      ]);
      if (stale) return;
      if (versionResult.success) setVersions(versionResult.versions ?? []);
      if (schemaResult.success && schemaResult.schema) setSchema(schemaResult.schema);
      const failure = !versionResult.success
        ? versionResult.error
        : !schemaResult.success
          ? schemaResult.error
          : undefined;
      setError(failure ?? null);
    })();
    return () => {
      stale = true;
    };
  }, [api, connected, connectionId, source, selectedSubject, selectedVersion]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const all = subjects ?? [];
    return (needle ? all.filter((s) => s.toLowerCase().includes(needle)) : all).slice(
      0,
      MAX_VISIBLE_SUBJECTS
    );
  }, [query, subjects]);

  const changeSource = (next: SchemaSource): void => {
    setSource(next);
    setError(null);
    if (next !== 'id') onSchemaIdChange('');
    if (next !== 'subject') onSubjectChange(null);
  };

  const generate = (): void => {
    if (!schema) return;
    const result = generateSchemaExample(schema.schemaType, schema.schema);
    if (result.ok) {
      setExampleError(null);
      onGenerateExample(result.json);
    } else {
      setExampleError(result.error);
    }
  };

  return (
    <div className="space-y-2 rounded-sp-btn border border-sp-line p-3 bg-sp-surface-lo">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-xs sp-label">{label} schema (optional)</Label>
        <Select value={source} onValueChange={(value) => changeSource(value as SchemaSource)}>
          <SelectTrigger aria-label={`${label} schema source`} className="h-7 w-40 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">No schema</SelectItem>
            <SelectItem value="subject">Registry subject</SelectItem>
            <SelectItem value="id">Schema ID</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {source === 'none' && (
        <p className="text-sp-11 text-sp-muted">
          No schema — the {field} is sent as a plain string.
        </p>
      )}

      {source === 'id' && (
        <>
          <Input
            aria-label={`${label} schema ID`}
            type="number"
            min={1}
            value={schemaId}
            onChange={(event) => onSchemaIdChange(event.target.value)}
            placeholder={`e.g. ${field === 'key' ? 2 : 1} — encode the ${field} with this registry schema`}
            className="h-8 text-xs font-mono"
          />
          <p className="text-sp-11 text-sp-muted">
            {schemaId.trim()
              ? `${label} is parsed as JSON and Confluent-encoded with this schema${
                  field === 'key'
                    ? ' (requires a key; decoded on consume).'
                    : ' (decoded on consume).'
                }`
              : `No schema ID — the ${field} is sent as a plain string.`}
          </p>
        </>
      )}

      {source === 'subject' && (
        <div className="space-y-2">
          {!connected && (
            <p className="text-sp-11 text-sp-muted">Connect to browse registry subjects.</p>
          )}
          <div className="flex items-center gap-2">
            <Input
              aria-label={`${label} subject filter`}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={defaultSubject || 'Filter subjects'}
              className="h-8 text-xs font-mono"
            />
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label={`Refresh ${field} subjects`}
              disabled={!connected}
              onClick={() => void loadSubjects()}
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </div>
          {subjects !== null && (
            <ul
              aria-label={`${label} subjects`}
              className="max-h-28 overflow-auto rounded-sp-btn border border-sp-line"
            >
              {filtered.length === 0 ? (
                <li className="px-2 py-1 text-sp-11 text-sp-dim">No subjects match.</li>
              ) : (
                filtered.map((name) => (
                  <li key={name}>
                    <button
                      type="button"
                      aria-pressed={name === selectedSubject}
                      onClick={() => {
                        setQuery(name);
                        onSubjectChange({ subject: name, version: 'latest' });
                      }}
                      className={cn(
                        'w-full truncate px-2 py-1 text-left font-mono text-xs hover:bg-sp-surface-hi',
                        name === selectedSubject && 'bg-sp-surface-hi text-sp-text'
                      )}
                    >
                      {name}
                    </button>
                  </li>
                ))
              )}
            </ul>
          )}
          {subject && (
            <div className="flex items-center gap-2">
              <Label className="text-xs sp-label">Version</Label>
              <Select
                value={String(subject.version)}
                onValueChange={(value) =>
                  onSubjectChange({
                    subject: subject.subject,
                    version: value === 'latest' ? 'latest' : Number(value),
                  })
                }
              >
                <SelectTrigger aria-label={`${label} schema version`} className="h-7 w-32 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="latest">latest</SelectItem>
                  {[...versions].reverse().map((version) => (
                    <SelectItem key={version} value={String(version)}>
                      v{version}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {schema && (
            <div className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-sp-11 text-sp-muted">
                  ID {schema.id} · {schema.schemaType} · {schema.subject} v{schema.version}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={schema.schemaType === 'PROTOBUF'}
                  title={
                    schema.schemaType === 'PROTOBUF'
                      ? 'Example generation supports Avro and JSON Schema.'
                      : undefined
                  }
                  onClick={generate}
                >
                  <Sparkles className="h-3.5 w-3.5 mr-1.5" /> Generate example
                </Button>
              </div>
              <pre
                aria-label={`${label} schema`}
                className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-sp-btn border border-sp-line p-2 font-mono text-sp-11 text-sp-text"
              >
                {formatSchemaText(schema.schemaType, schema.schema)}
              </pre>
              {exampleError && <p className="text-xs text-red-400">{exampleError}</p>}
            </div>
          )}
          <p className="text-sp-11 text-sp-muted">
            {subject
              ? `${label} is parsed as JSON and Confluent-encoded with ${subject.subject} (${
                  subject.version === 'latest' ? 'latest' : `v${subject.version}`
                }); the schema ID is resolved when you publish.`
              : 'Pick a subject — no schema is applied until one is selected.'}
          </p>
        </div>
      )}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
