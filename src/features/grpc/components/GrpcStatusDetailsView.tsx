import { Crosshair } from 'lucide-react';
import type { GrpcStatusDetail } from '@/types';
import { fieldViolationsOf } from '../lib/grpcFieldViolations';

/** `google.rpc.BadRequest` → `BadRequest`. */
function shortTypeName(type: string): string {
  const dot = type.lastIndexOf('.');
  return dot >= 0 ? type.slice(dot + 1) : type;
}

function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

interface GrpcStatusDetailsViewProps {
  details: ReadonlyArray<GrpcStatusDetail>;
  /** Jump to the Nth BadRequest field violation in the request editor (#941). */
  onJumpToViolation?: ((index: number) => void) | undefined;
}

/**
 * The decoded google.rpc.Status details of a gRPC error (#883): one card per
 * `Any`. Known google.rpc types (and types the call's schema knows) show their
 * proto3-JSON value; anything else shows its type URL + raw base64. Connect's
 * optional `debug` rendering is shown alongside.
 */
export function GrpcStatusDetailsView({ details, onJumpToViolation }: GrpcStatusDetailsViewProps) {
  const violations = fieldViolationsOf(details);
  return (
    <div>
      {violations.length > 0 && (
        <section className="px-3.5 pt-3 font-mono text-sp-11-5" aria-label="Field violations">
          <p className="text-sp-muted pb-1">Field violations — click to jump to the field</p>
          <ul className="flex flex-col">
            {violations.map((v, i) => (
              <li key={`${v.field}-${i}`}>
                <button
                  type="button"
                  className="flex w-full items-baseline gap-2 rounded px-2 py-1 text-left hover:bg-sp-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
                  onClick={() => onJumpToViolation?.(i)}
                  disabled={!onJumpToViolation}
                  title={onJumpToViolation ? 'Show this field in the request message' : undefined}
                >
                  <Crosshair className="h-3 w-3 shrink-0 self-center text-sp-muted" />
                  <span style={{ color: 'var(--color-danger)' }}>{v.field || '(request)'}</span>
                  <span className="text-sp-text">{v.description}</span>
                  {v.reason && <span className="text-sp-muted">{v.reason}</span>}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <ul className="flex flex-col gap-2 px-3.5 py-3" aria-label="Error details">
        {details.map((d, i) => (
          <li
            key={`${d.type}-${i}`}
            className="rounded-sp-panel border font-mono text-sp-11-5"
            style={{ borderColor: 'var(--sp-line)' }}
          >
            <div className="flex items-baseline gap-2 px-3 py-1.5 border-b border-sp-line">
              <span className="text-sp-text font-semibold">{shortTypeName(d.type)}</span>
              <span className="text-sp-muted truncate">{d.type}</span>
            </div>
            {d.value !== undefined ? (
              <pre className="px-3 py-2 text-sp-text whitespace-pre-wrap break-all">
                {pretty(d.value)}
              </pre>
            ) : (
              <div className="px-3 py-2">
                <p className="text-sp-muted">Unknown type — raw bytes (base64):</p>
                <pre className="text-sp-text whitespace-pre-wrap break-all">
                  {d.raw || '(empty)'}
                </pre>
              </div>
            )}
            {d.debug !== undefined && (
              <div className="px-3 pb-2">
                <p className="text-sp-muted">debug</p>
                <pre className="text-sp-text whitespace-pre-wrap break-all">{pretty(d.debug)}</pre>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
