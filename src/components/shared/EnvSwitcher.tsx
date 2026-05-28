'use client';

import * as React from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { Check, Plus, Globe } from 'lucide-react';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { cn } from '@/lib/shared/utils';
import { envColorFor } from '@/features/environments/lib/envColor';
import type { Environment } from '@/types';
import { v4 as uuidv4 } from 'uuid';

/**
 * Detect a "host-like" variable to surface as the row subtitle. Falls back to
 * a vars count.
 */
function describeEnv(env: Environment): string {
  const host = env.variables.find((v) =>
    ['host', 'base_url', 'baseurl', 'url', 'api_url', 'apiurl'].includes(v.key.toLowerCase())
  );
  if (host && host.value) {
    try {
      const u = new URL(host.value);
      return u.host;
    } catch {
      return host.value.replace(/^https?:\/\//, '');
    }
  }
  const n = env.variables.length;
  return `${n} variable${n === 1 ? '' : 's'}`;
}

export interface EnvSwitcherProps {
  /** The element that opens the popover. Wrapped in Popover.Trigger via asChild. */
  trigger: React.ReactNode;
  /** Optional callback to launch a richer "New environment" flow (e.g. open EnvironmentManager). */
  onNewEnvironment?: () => void;
  /** Popover side; defaults to 'top' to match the sidebar's env footer anchor. */
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
}

export default function EnvSwitcher({
  trigger,
  onNewEnvironment,
  side = 'top',
  align = 'start',
}: EnvSwitcherProps) {
  const environments = useEnvironmentStore((s) => s.environments);
  const activeId = useEnvironmentStore((s) => s.activeEnvironmentId);
  const setActiveEnvironment = useEnvironmentStore((s) => s.setActiveEnvironment);
  const addEnvironment = useEnvironmentStore((s) => s.addEnvironment);

  const [open, setOpen] = React.useState(false);

  const handleNew = React.useCallback(() => {
    setOpen(false);
    if (onNewEnvironment) {
      onNewEnvironment();
      return;
    }
    // Fallback: create a blank environment inline so the popover always has
    // a working footer action even without an external manager dialog.
    const env: Environment = {
      id: uuidv4(),
      name: `Environment ${environments.length + 1}`,
      variables: [],
    };
    addEnvironment(env);
    setActiveEnvironment(env.id);
  }, [onNewEnvironment, addEnvironment, environments.length, setActiveEnvironment]);

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>{trigger}</PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side={side}
          align={align}
          sideOffset={8}
          className={cn(
            'z-50 w-[320px] rounded-sp-panel border border-sp-line-strong outline-none',
            'sp-floater-lg',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
            'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95'
          )}
          style={{
            background: 'var(--sp-surface-hi)',
            backdropFilter: 'blur(24px) saturate(180%)',
            WebkitBackdropFilter: 'blur(24px) saturate(180%)',
          }}
        >
          {/* Header */}
          <div className="px-4 pt-3 pb-2">
            <div className="sp-label">Switch environment</div>
          </div>

          {/* Rows */}
          <div className="max-h-[320px] overflow-y-auto px-1.5 pb-1.5">
            {environments.length === 0 ? (
              <div className="px-3 py-6 text-center text-sp-12 text-sp-muted">
                <Globe size={20} className="mx-auto mb-2 opacity-50" />
                No environments yet
              </div>
            ) : (
              environments.map((env) => {
                const isActive = env.id === activeId;
                const color = envColorFor(env);
                return (
                  <button
                    key={env.id}
                    type="button"
                    onClick={() => {
                      setActiveEnvironment(env.id);
                      setOpen(false);
                    }}
                    className={cn(
                      'relative flex items-center gap-3 w-full text-left rounded-sp-btn px-2.5 py-2',
                      'transition-colors',
                      isActive ? 'bg-sp-active' : 'hover:bg-sp-hover'
                    )}
                    style={isActive ? { boxShadow: 'inset 2px 0 0 0 var(--sp-accent)' } : undefined}
                  >
                    {/* Color dot with halo */}
                    <span
                      aria-hidden="true"
                      className="shrink-0 inline-block rounded-full"
                      style={{
                        width: 10,
                        height: 10,
                        background: color,
                        boxShadow: `0 0 0 3px ${color}26, 0 0 8px ${color}88`,
                      }}
                    />
                    {/* Name + subtitle */}
                    <div className="flex-1 min-w-0">
                      <div className="text-sp-13 font-medium text-sp-text truncate">{env.name}</div>
                      <div className="text-sp-10-5 text-sp-dim font-mono truncate">
                        {describeEnv(env)}
                      </div>
                    </div>
                    {isActive && (
                      <Check size={14} className="text-sp-accent shrink-0" aria-hidden="true" />
                    )}
                  </button>
                );
              })
            )}

            {/* "No env" / clear option */}
            {environments.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  setActiveEnvironment(null);
                  setOpen(false);
                }}
                className={cn(
                  'relative flex items-center gap-3 w-full text-left rounded-sp-btn px-2.5 py-2',
                  'transition-colors',
                  activeId === null ? 'bg-sp-active' : 'hover:bg-sp-hover'
                )}
                style={
                  activeId === null ? { boxShadow: 'inset 2px 0 0 0 var(--sp-accent)' } : undefined
                }
              >
                <span
                  aria-hidden="true"
                  className="shrink-0 inline-block rounded-full border border-sp-line-strong"
                  style={{ width: 10, height: 10 }}
                />
                <div className="flex-1 min-w-0">
                  <div className="text-sp-13 font-medium text-sp-text truncate">No environment</div>
                  <div className="text-sp-10-5 text-sp-dim font-mono truncate">
                    Skip variable resolution
                  </div>
                </div>
                {activeId === null && (
                  <Check size={14} className="text-sp-accent shrink-0" aria-hidden="true" />
                )}
              </button>
            )}
          </div>

          {/* Footer */}
          <div className="border-t border-sp-line p-1.5">
            <button
              type="button"
              onClick={handleNew}
              className={cn(
                'flex items-center gap-2 w-full text-left rounded-sp-btn px-2.5 py-2',
                'text-sp-13 text-sp-muted hover:text-sp-text hover:bg-sp-hover transition-colors'
              )}
            >
              <Plus size={14} />
              <span>New environment</span>
            </button>
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
