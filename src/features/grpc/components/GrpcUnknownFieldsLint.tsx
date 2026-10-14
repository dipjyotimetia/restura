import { findUnknownJsonFields } from '@shared/protocol/grpc-unknown-fields';
import { AlertTriangle, Ban } from 'lucide-react';
import { useMemo } from 'react';
import { Button } from '@/components/ui/button';
import {
  parseMessageForLint,
  removeJsonKeys,
  renameJsonKey,
  resolveInputMessage,
  schemaSourceFromSnapshot,
} from '@/features/grpc/lib/unknownFields';
import { useActiveRequest } from '@/store/selectors';
import { useSettingsStore } from '@/store/useSettingsStore';

interface GrpcUnknownFieldsLintProps {
  /** Applies a quick-fix edit to the request message (the builder's change handler). */
  onMessageChange: (message: string) => void;
}

/**
 * Live lint for the gRPC request editor (#944): flags JSON keys the selected
 * method's input message doesn't define, with did-you-mean rename quick fixes.
 * Follows Settings → Requests → gRPC "Unknown request fields": `warn` (fields
 * are dropped on send), `block` (send refused), `off` (hidden).
 *
 * Needs an authoritative schema on the request — an upload, or reflection
 * descriptors (desktop); otherwise it stays quiet.
 */
export function GrpcUnknownFieldsLint({ onMessageChange }: GrpcUnknownFieldsLintProps) {
  const request = useActiveRequest('grpc');
  const mode = useSettingsStore((s) => s.settings.grpcUnknownFields ?? 'warn');
  const schema = request?.schema;
  const service = request?.service ?? '';
  const method = request?.method ?? '';
  const message = request?.message ?? '';

  const input = useMemo(
    () =>
      mode === 'off'
        ? null
        : resolveInputMessage({ service, method }, schemaSourceFromSnapshot(schema)),
    [mode, schema, service, method]
  );
  const unknown = useMemo(() => {
    const json = input ? parseMessageForLint(message) : undefined;
    return input && json !== undefined ? findUnknownJsonFields(input, json) : [];
  }, [input, message]);

  if (!input || unknown.length === 0) return null;
  const blocking = mode === 'block';
  const Icon = blocking ? Ban : AlertTriangle;

  return (
    <div
      role="status"
      aria-label="Unknown request fields"
      className="mb-2 rounded-sp-btn border px-2.5 py-2 text-sp-11 font-mono flex flex-col gap-1.5"
      style={{
        color: blocking ? 'var(--color-danger)' : 'var(--color-warning)',
        borderColor: blocking ? 'var(--color-danger)' : 'var(--color-warning)',
      }}
    >
      <div className="flex items-center gap-1.5">
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span className="flex-1">
          {unknown.length === 1 ? 'Unknown field' : `${unknown.length} unknown fields`} for{' '}
          {input.name} —{' '}
          {blocking ? 'sending is blocked until fixed.' : 'they will be dropped when sent.'}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-sp-11"
          onClick={() => onMessageChange(removeJsonKeys(message, unknown))}
        >
          Remove {unknown.length === 1 ? 'it' : 'all'}
        </Button>
      </div>
      <ul className="flex flex-col gap-1 pl-5">
        {unknown.map((field) => (
          <li key={field.path} className="flex items-center gap-2">
            <code className="text-sp-text">{field.path}</code>
            {field.suggestion && (
              <Button
                variant="outline"
                size="sm"
                className="h-6 px-2 text-sp-11"
                aria-label={`Rename ${field.path} to ${field.suggestion}`}
                onClick={() =>
                  onMessageChange(renameJsonKey(message, field, field.suggestion as string))
                }
              >
                Rename to “{field.suggestion}”
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default GrpcUnknownFieldsLint;
