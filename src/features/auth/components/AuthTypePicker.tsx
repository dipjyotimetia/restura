import { cn } from '@/lib/shared/utils';
import type { AuthConfig, AuthType } from '@/types';
import { authTypeLabel, useInheritedAuth } from './InheritedAuthHint';

export interface AuthTypeGroup {
  label: string;
  options: ReadonlyArray<{ value: AuthType; label: string }>;
}

interface AuthTypePickerProps {
  request: { id: string; auth: AuthConfig };
  groups: ReadonlyArray<AuthTypeGroup>;
  onChange: (auth: AuthConfig) => void;
  /** Accessible name of the picker (e.g. "gRPC authentication type"). */
  ariaLabel: string;
}

/**
 * The auth-method list for a request's Auth tab: one pressed button per type,
 * grouped. "No Auth" reads "Inherit (…)" when a folder / collection supplies
 * auth, because that is what the request will then send.
 */
export function AuthTypePicker({ request, groups, onChange, ariaLabel }: AuthTypePickerProps) {
  const inheritedAuth = useInheritedAuth(request);
  return (
    <fieldset aria-label={ariaLabel} className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
      {groups.map((group) => (
        <div key={group.label} className="flex flex-col gap-0.5">
          <span className="sp-label px-2 py-1">{group.label}</span>
          {group.options.map((opt) => {
            const selected = request.auth.type === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => onChange({ ...request.auth, type: opt.value })}
                className={cn(
                  'relative text-left px-3 py-1.5 rounded-sp-btn text-sp-12 transition-colors',
                  'hover:bg-sp-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent/40',
                  selected
                    ? 'bg-sp-active text-sp-text font-semibold'
                    : 'text-sp-muted hover:text-sp-text'
                )}
                aria-pressed={selected}
              >
                {selected && (
                  <span
                    aria-hidden="true"
                    className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-r-full"
                    style={{
                      background: 'var(--sp-accent)',
                      boxShadow: '0 0 8px var(--sp-accent-glow-88)',
                    }}
                  />
                )}
                {/* 'No Auth' means "inherit" when a parent defines auth. */}
                {opt.value === 'none' && inheritedAuth
                  ? `Inherit (${authTypeLabel(inheritedAuth.auth.type)})`
                  : opt.label}
              </button>
            );
          })}
        </div>
      ))}
    </fieldset>
  );
}
