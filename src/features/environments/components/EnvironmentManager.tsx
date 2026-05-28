import { useMemo, useState, useEffect, useRef, type ReactNode } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as DropdownPrimitive from '@radix-ui/react-dropdown-menu';
import {
  X,
  Plus,
  Trash2,
  Globe,
  Check,
  Search,
  MoreHorizontal,
  Copy,
  PencilLine,
  Eye,
  KeyRound,
  Sparkles,
} from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { envColorFor } from '@/features/environments/lib/envColor';
import { Floater } from '@/components/ui/spatial';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { withErrorBoundary } from '@/components/shared/ErrorBoundary';
import KeyValueEditor from '@/components/shared/KeyValueEditor';
import { cn } from '@/lib/shared/utils';
import type { Environment, KeyValue } from '@/types';

interface EnvironmentManagerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface EnvStats {
  varCount: number;
  secretCount: number;
}

function getStats(env: Environment | undefined): EnvStats {
  if (!env) return { varCount: 0, secretCount: 0 };
  return {
    varCount: env.variables.length,
    secretCount: env.variables.filter((v) => v.secret).length,
  };
}

/** Surface a "host"-like variable so the list row + detail header can hint
 *  at what the env points at (api.example.com etc.). */
function hostHint(env: Environment): string | null {
  const known = new Set(['host', 'baseurl', 'base_url', 'apihost', 'api_host', 'url', 'api_url']);
  const match = env.variables.find(
    (v) => v.enabled && known.has(v.key.toLowerCase().replace(/-/g, '_'))
  );
  if (!match || !match.value) return null;
  try {
    return new URL(match.value).host;
  } catch {
    return match.value.replace(/^https?:\/\//i, '').replace(/\/$/, '');
  }
}

interface EnvDot {
  color: string;
  size?: number;
  active?: boolean;
}

function EnvDot({ color, size = 10, active }: EnvDot) {
  return (
    <span
      aria-hidden="true"
      className="inline-block rounded-full shrink-0"
      style={{
        width: size,
        height: size,
        background: color,
        boxShadow: active ? `0 0 0 3px ${color}33, 0 0 10px ${color}77` : `0 0 0 2px ${color}22`,
      }}
    />
  );
}

interface EnvRowProps {
  env: Environment;
  isSelected: boolean;
  isActive: boolean;
  onSelect: () => void;
  onDelete: () => void;
}

function EnvRow({ env, isSelected, isActive, onSelect, onDelete }: EnvRowProps) {
  const color = envColorFor(env);
  const hint = hostHint(env);
  const stats = getStats(env);

  return (
    <div
      className={cn(
        'group relative flex items-center gap-2.5 rounded-sp-btn px-2.5 py-2 cursor-pointer',
        'transition-colors',
        isSelected ? 'bg-sp-active' : 'hover:bg-sp-hover'
      )}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      role="button"
      tabIndex={0}
      aria-current={isSelected ? 'true' : undefined}
    >
      {isSelected && (
        <span
          aria-hidden="true"
          className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-sp-accent"
          style={{ boxShadow: '0 0 8px var(--sp-accent-glow-55)' }}
        />
      )}
      <EnvDot color={color} active={isActive} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span
            className={cn(
              'text-sp-12-5 truncate',
              isSelected ? 'font-semibold text-sp-text' : 'text-sp-text'
            )}
          >
            {env.name}
          </span>
          {isActive && (
            <span
              className="inline-flex items-center px-1.5 h-4 rounded-sp-chip text-[10px] font-semibold text-sp-accent"
              style={{ background: 'var(--sp-accent-glow-33)' }}
            >
              Active
            </span>
          )}
        </div>
        <div className="text-sp-10-5 text-sp-muted font-mono truncate">
          {hint
            ? hint
            : `${stats.varCount} variable${stats.varCount === 1 ? '' : 's'}${
                stats.secretCount > 0 ? ` · ${stats.secretCount} secret` : ''
              }`}
        </div>
      </div>
      <button
        type="button"
        aria-label={`Delete ${env.name}`}
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        className={cn(
          'opacity-0 group-hover:opacity-100 transition-opacity shrink-0',
          'inline-flex items-center justify-center size-6 rounded-sp-btn',
          'text-sp-muted hover:text-rose-400 hover:bg-sp-surface',
          'focus:opacity-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent'
        )}
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
}

interface Scaffold {
  name: string;
  color: string;
  hint: string;
}

const SCAFFOLDS: Scaffold[] = [
  { name: 'Local', color: '#4d9fff', hint: 'localhost · dev keys' },
  { name: 'Staging', color: '#f59e0b', hint: 'staging APIs' },
  { name: 'Production', color: '#22c55e', hint: 'live traffic' },
];

interface EmptyStateProps {
  onCreate: (name: string) => void;
}

function EmptyState({ onCreate }: EmptyStateProps) {
  return (
    <div className="flex-1 flex flex-col items-center justify-center px-8 py-10 text-center">
      <div
        aria-hidden="true"
        className="flex items-center justify-center size-14 rounded-sp-btn border border-sp-line mb-4"
        style={{
          background:
            'linear-gradient(135deg, var(--sp-accent-glow-33), transparent 70%), var(--sp-surface-lo)',
        }}
      >
        <Globe size={22} className="text-sp-accent" />
      </div>
      <h2 className="text-sp-16 font-bold text-sp-text">No environments yet</h2>
      <p className="text-sp-12-5 text-sp-muted mt-1 max-w-xs">
        Environments hold reusable variables — host names, API keys, feature flags — that swap in
        via <code className="font-mono text-sp-text">{'{{var}}'}</code> at request time.
      </p>
      <div className="mt-5 grid grid-cols-3 gap-2.5 w-full max-w-md">
        {SCAFFOLDS.map((s) => (
          <button
            key={s.name}
            type="button"
            onClick={() => onCreate(s.name)}
            className={cn(
              'flex flex-col items-start gap-1.5 p-3 rounded-sp-btn text-left',
              'bg-sp-surface-lo border border-sp-line',
              'hover:border-sp-accent hover:bg-sp-hover transition-colors',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent'
            )}
          >
            <EnvDot color={s.color} />
            <span className="text-sp-12-5 font-semibold text-sp-text">{s.name}</span>
            <span className="text-sp-11 text-sp-muted">{s.hint}</span>
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={() => onCreate('New environment')}
        className={cn(
          'mt-5 inline-flex items-center gap-1.5 h-9 px-4 rounded-sp-btn',
          'bg-sp-accent text-white text-sp-12-5 font-semibold',
          'hover:opacity-90 transition-opacity',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent'
        )}
      >
        <Plus size={14} /> Create blank environment
      </button>
    </div>
  );
}

function UsageHints() {
  type Tab = 'variable' | 'dynamic' | 'secret';
  const [tab, setTab] = useState<Tab>('variable');
  const TABS: Array<{ id: Tab; label: string; icon: typeof Eye }> = [
    { id: 'variable', label: '{{variable}}', icon: Eye },
    { id: 'dynamic', label: '{{$dynamic}}', icon: Sparkles },
    { id: 'secret', label: 'Secrets', icon: KeyRound },
  ];

  const panelId = `usage-hints-${tab}`;
  return (
    <Floater radius="panel" elevation="inset" className="p-3">
      <div role="tablist" aria-label="Variable syntax" className="flex items-center gap-1 mb-2.5">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={`usage-hints-${t.id}`}
              onClick={() => setTab(t.id)}
              className={cn(
                'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-sp-btn transition-colors',
                'text-sp-11-5 font-medium',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent',
                active
                  ? 'bg-sp-active text-sp-accent'
                  : 'text-sp-muted hover:text-sp-text hover:bg-sp-hover'
              )}
            >
              <Icon size={12} />
              <span className="font-mono">{t.label}</span>
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id={panelId}
        aria-labelledby={panelId}
        className="text-sp-12 text-sp-muted leading-relaxed"
      >
        {tab === 'variable' && (
          <>
            Reference a variable from anywhere — URL, headers, body, scripts — with{' '}
            <code className="font-mono text-sp-text">{'{{variableName}}'}</code>. Active environment
            wins; missing variables surface as inline warnings before the request fires.
          </>
        )}
        {tab === 'dynamic' && (
          <>
            Built-in helpers expand at send time:{' '}
            <code className="font-mono text-sp-text">{'{{$timestamp}}'}</code>,{' '}
            <code className="font-mono text-sp-text">{'{{$guid}}'}</code>,{' '}
            <code className="font-mono text-sp-text">{'{{$randomInt}}'}</code>,{' '}
            <code className="font-mono text-sp-text">{'{{$isoDate}}'}</code>. They override
            environment variables of the same name.
          </>
        )}
        {tab === 'secret' && (
          <>
            Click <KeyRound size={11} className="inline align-text-bottom text-amber-400" /> next to
            a variable to mark it as secret — the value is masked in the UI and in collection
            exports. On desktop, secrets can move to the OS keychain via Settings → Secrets.
          </>
        )}
      </div>
    </Floater>
  );
}

interface EnvDetailHeaderProps {
  env: Environment;
  isActive: boolean;
  stats: EnvStats;
  onRename: (name: string) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

function EnvDetailHeader({
  env,
  isActive,
  stats,
  onRename,
  onDuplicate,
  onDelete,
}: EnvDetailHeaderProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(env.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraft(env.name);
    setEditing(false);
  }, [env.id, env.name]);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const color = envColorFor(env);
  const host = hostHint(env);

  const commit = () => {
    const next = draft.trim();
    if (next && next !== env.name) onRename(next);
    setEditing(false);
  };

  return (
    <div className="flex items-center gap-3 px-5 py-3 border-b border-sp-line shrink-0">
      <EnvDot color={color} size={12} active={isActive} />
      <div className="flex-1 min-w-0">
        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') {
                setDraft(env.name);
                setEditing(false);
              }
            }}
            className={cn(
              'w-full h-7 px-2 rounded-sp-btn',
              'bg-sp-surface-lo border border-sp-line-strong text-sp-text text-sp-15 font-bold',
              'focus:outline-none focus:ring-2 focus:ring-sp-accent'
            )}
          />
        ) : (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className={cn(
              'group flex items-center gap-2 text-sp-15 font-bold text-sp-text',
              'rounded-sp-btn px-1 -mx-1 hover:bg-sp-hover transition-colors',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent'
            )}
            title="Click to rename"
          >
            <span className="truncate">{env.name}</span>
            <PencilLine
              size={12}
              className="text-sp-muted opacity-0 group-hover:opacity-100 transition-opacity"
            />
          </button>
        )}
        <div className="text-sp-11 text-sp-muted mt-0.5 font-mono">
          {stats.varCount} variable{stats.varCount === 1 ? '' : 's'}
          {stats.secretCount > 0 &&
            ` · ${stats.secretCount} secret${stats.secretCount === 1 ? '' : 's'}`}
          {host && ` · ${host}`}
        </div>
      </div>
      {isActive && (
        <span
          className="inline-flex items-center px-2 h-5 rounded-sp-pill text-sp-11 font-semibold text-sp-accent border border-sp-line"
          style={{ background: 'var(--sp-accent-glow-33)' }}
        >
          Active
        </span>
      )}
      <DropdownPrimitive.Root>
        <DropdownPrimitive.Trigger asChild>
          <button
            type="button"
            aria-label="Environment actions"
            className={cn(
              'inline-flex items-center justify-center size-8 rounded-sp-btn',
              'bg-sp-surface-lo border border-sp-line text-sp-muted',
              'hover:text-sp-text hover:bg-sp-hover transition-colors',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent'
            )}
          >
            <MoreHorizontal size={14} />
          </button>
        </DropdownPrimitive.Trigger>
        <DropdownPrimitive.Portal>
          <DropdownPrimitive.Content
            align="end"
            sideOffset={6}
            className={cn(
              'z-[60] min-w-[180px] rounded-sp-panel border border-sp-line-strong p-1',
              'sp-floater-lg outline-none',
              'data-[state=open]:animate-in data-[state=closed]:animate-out',
              'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0'
            )}
            style={{ background: 'var(--sp-surface-hi)' }}
          >
            <DropdownItem onSelect={() => setEditing(true)} icon={PencilLine}>
              Rename
            </DropdownItem>
            <DropdownItem onSelect={onDuplicate} icon={Copy}>
              Duplicate
            </DropdownItem>
            <DropdownPrimitive.Separator className="my-1 h-px bg-sp-line" />
            <DropdownItem onSelect={onDelete} icon={Trash2} destructive>
              Delete
            </DropdownItem>
          </DropdownPrimitive.Content>
        </DropdownPrimitive.Portal>
      </DropdownPrimitive.Root>
    </div>
  );
}

interface DropdownItemProps {
  icon: typeof PencilLine;
  destructive?: boolean;
  onSelect: () => void;
  children: ReactNode;
}

function DropdownItem({ icon: Icon, destructive, onSelect, children }: DropdownItemProps) {
  return (
    <DropdownPrimitive.Item
      // No preventDefault — Radix auto-closes the menu after select. Rename
      // works because the action sets editing=true *before* the close; the
      // header re-renders with the input in edit mode after dismissal.
      onSelect={() => onSelect()}
      className={cn(
        'flex items-center gap-2 h-8 px-2.5 rounded-sp-btn text-sp-12-5 cursor-pointer',
        'outline-none transition-colors',
        destructive
          ? 'text-rose-400 data-[highlighted]:bg-rose-500/10'
          : 'text-sp-text data-[highlighted]:bg-sp-hover'
      )}
    >
      <Icon size={12} aria-hidden="true" />
      {children}
    </DropdownPrimitive.Item>
  );
}

function EnvironmentManager({ open, onOpenChange }: EnvironmentManagerProps) {
  const {
    environments,
    activeEnvironmentId,
    addEnvironment,
    updateEnvironment,
    removeEnvironment,
    setActiveEnvironment,
    addVariable,
    updateVariable,
    removeVariable,
    createNewEnvironment,
  } = useEnvironmentStore();

  const [selectedEnvId, setSelectedEnvId] = useState<string | null>(
    activeEnvironmentId || environments[0]?.id || null
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [envToDelete, setEnvToDelete] = useState<string | null>(null);

  // Keep selection in sync when envs change underneath (e.g. delete of selected).
  useEffect(() => {
    if (selectedEnvId && !environments.find((e) => e.id === selectedEnvId)) {
      setSelectedEnvId(environments[0]?.id ?? null);
    } else if (!selectedEnvId && environments.length > 0) {
      setSelectedEnvId(environments[0]?.id ?? null);
    }
  }, [environments, selectedEnvId]);

  const selectedEnv = environments.find((env) => env.id === selectedEnvId) ?? undefined;
  const filteredEnvs = useMemo(() => {
    if (!searchQuery.trim()) return environments;
    const q = searchQuery.trim().toLowerCase();
    return environments.filter((e) => e.name.toLowerCase().includes(q));
  }, [environments, searchQuery]);

  const createEnv = (name: string) => {
    const env = createNewEnvironment(name);
    addEnvironment(env);
    setSelectedEnvId(env.id);
  };

  const duplicateEnv = (source: Environment) => {
    const clone: Environment = {
      ...source,
      id: uuidv4(),
      name: `${source.name} (copy)`,
      variables: source.variables.map((v) => ({ ...v, id: uuidv4() })),
    };
    addEnvironment(clone);
    setSelectedEnvId(clone.id);
  };

  const handleDeleteEnvironment = (id: string) => {
    setEnvToDelete(id);
    setDeleteDialogOpen(true);
  };

  const confirmDeleteEnvironment = () => {
    if (envToDelete) {
      removeEnvironment(envToDelete);
      setEnvToDelete(null);
    }
    setDeleteDialogOpen(false);
  };

  const handleAddVariable = () => {
    if (!selectedEnvId) return;
    const v: KeyValue = { id: uuidv4(), key: '', value: '', enabled: true };
    addVariable(selectedEnvId, v);
  };

  const stats = getStats(selectedEnv);
  const isActiveSelected = selectedEnvId !== null && selectedEnvId === activeEnvironmentId;
  const canSetActive = selectedEnvId !== null && !isActiveSelected;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            'fixed inset-0 z-50',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0'
          )}
          style={{
            background: 'rgba(0,0,0,0.55)',
            backdropFilter: 'blur(6px)',
            WebkitBackdropFilter: 'blur(6px)',
          }}
        />
        <DialogPrimitive.Content
          aria-label="Environments"
          className={cn(
            'fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2',
            'w-[920px] max-w-[calc(100vw-32px)] h-[640px] max-h-[calc(100vh-32px)]',
            'flex flex-col rounded-sp-window border border-sp-line-strong outline-none',
            'data-[state=open]:animate-in data-[state=closed]:animate-out',
            'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
            'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95'
          )}
          style={{
            background: 'var(--sp-surface-hi)',
            boxShadow: '0 30px 80px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.04)',
          }}
        >
          <DialogPrimitive.Title className="sr-only">Environments</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Define reusable variables per stage
          </DialogPrimitive.Description>

          {/* Header */}
          <div className="flex items-start justify-between gap-4 px-6 pt-5 pb-4 border-b border-sp-line shrink-0">
            <div className="flex items-start gap-3">
              <div
                aria-hidden="true"
                className="shrink-0 flex items-center justify-center size-10 rounded-sp-btn border border-sp-line"
                style={{
                  background:
                    'linear-gradient(135deg, var(--sp-accent-glow-33), transparent 70%), var(--sp-surface-lo)',
                  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06)',
                }}
              >
                <Globe size={18} className="text-sp-accent" />
              </div>
              <div className="flex flex-col leading-tight">
                <h1 className="text-sp-18 font-bold text-sp-text">Environments</h1>
                <p className="text-sp-12-5 text-sp-muted mt-0.5">
                  Reusable variables per stage — dev, staging, production.
                </p>
              </div>
            </div>
            <DialogPrimitive.Close
              aria-label="Close environments"
              className={cn(
                'inline-flex items-center justify-center w-9 h-9 rounded-sp-btn shrink-0',
                'bg-sp-surface-lo border border-sp-line text-sp-muted',
                'hover:text-sp-text hover:bg-sp-hover hover:border-sp-line-strong',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent',
                'transition-colors'
              )}
            >
              <X size={14} />
            </DialogPrimitive.Close>
          </div>

          {/* Body */}
          <div className="flex flex-1 min-h-0">
            {environments.length === 0 ? (
              <EmptyState onCreate={createEnv} />
            ) : (
              <>
                {/* Left rail */}
                <nav
                  aria-label="Environments"
                  className="w-[244px] shrink-0 border-r border-sp-line flex flex-col"
                >
                  {environments.length >= 4 && (
                    <div className="px-3 pt-3 pb-2">
                      <div className="relative">
                        <Search
                          size={12}
                          className="absolute left-2 top-1/2 -translate-y-1/2 text-sp-muted pointer-events-none"
                        />
                        <input
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                          placeholder="Search environments…"
                          aria-label="Search environments"
                          className={cn(
                            'w-full h-7 pl-7 pr-2 rounded-sp-btn',
                            'bg-sp-surface-lo border border-sp-line text-sp-text text-sp-11-5',
                            'placeholder:text-sp-dim',
                            'focus:outline-none focus:ring-2 focus:ring-sp-accent'
                          )}
                        />
                      </div>
                    </div>
                  )}
                  <div className="flex-1 overflow-y-auto p-1.5 space-y-0.5">
                    {filteredEnvs.length === 0 ? (
                      <div className="text-center py-6 text-sp-11-5 text-sp-muted font-mono">
                        No matches
                      </div>
                    ) : (
                      filteredEnvs.map((env) => (
                        <EnvRow
                          key={env.id}
                          env={env}
                          isSelected={selectedEnvId === env.id}
                          isActive={activeEnvironmentId === env.id}
                          onSelect={() => setSelectedEnvId(env.id)}
                          onDelete={() => handleDeleteEnvironment(env.id)}
                        />
                      ))
                    )}
                  </div>
                  <div className="p-2 border-t border-sp-line">
                    <button
                      type="button"
                      onClick={() => createEnv(`Environment ${environments.length + 1}`)}
                      className={cn(
                        'inline-flex items-center justify-center gap-1.5 w-full h-8 rounded-sp-btn',
                        'bg-sp-surface-lo border border-sp-line text-sp-text text-sp-12 font-medium',
                        'hover:bg-sp-hover hover:border-sp-line-strong transition-colors',
                        'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent'
                      )}
                    >
                      <Plus size={12} />
                      New environment
                    </button>
                  </div>
                </nav>

                {/* Detail pane */}
                <div className="flex-1 flex flex-col min-w-0">
                  {selectedEnv ? (
                    <>
                      <EnvDetailHeader
                        env={selectedEnv}
                        isActive={activeEnvironmentId === selectedEnv.id}
                        stats={stats}
                        onRename={(name) => updateEnvironment(selectedEnv.id, { name })}
                        onDuplicate={() => duplicateEnv(selectedEnv)}
                        onDelete={() => handleDeleteEnvironment(selectedEnv.id)}
                      />
                      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
                        <section>
                          <div className="sp-label mb-2">Variables</div>
                          <Floater radius="panel" elevation="inset" className="p-3">
                            <KeyValueEditor
                              items={selectedEnv.variables}
                              onAdd={handleAddVariable}
                              onUpdate={(varId, updates) =>
                                updateVariable(selectedEnv.id, varId, updates)
                              }
                              onDelete={(varId) => removeVariable(selectedEnv.id, varId)}
                              keyPlaceholder="Variable name"
                              valuePlaceholder="Variable value"
                              addButtonText="Add variable"
                              itemType="variable"
                              enableSecrets
                            />
                          </Floater>
                        </section>
                        <section>
                          <div className="sp-label mb-2">Usage</div>
                          <UsageHints />
                        </section>
                      </div>
                    </>
                  ) : (
                    <div className="flex-1 flex flex-col items-center justify-center text-sp-muted">
                      <Globe size={20} className="opacity-50" />
                      <p className="text-sp-12 mt-2">Select an environment</p>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>

          {/* Footer (hidden when no envs — empty-state owns its CTA) */}
          {environments.length > 0 && (
            <div className="flex items-center justify-end gap-2 px-6 py-3 border-t border-sp-line shrink-0">
              <DialogPrimitive.Close
                className={cn(
                  'inline-flex items-center h-8 px-4 rounded-sp-btn',
                  'bg-sp-surface border border-sp-line text-sp-text text-sp-12 font-medium',
                  'hover:bg-sp-hover hover:border-sp-line-strong transition-colors',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent'
                )}
              >
                Close
              </DialogPrimitive.Close>
              <button
                type="button"
                disabled={!canSetActive}
                onClick={() => selectedEnvId && setActiveEnvironment(selectedEnvId)}
                className={cn(
                  'inline-flex items-center gap-1.5 h-8 px-4 rounded-sp-btn',
                  'bg-sp-accent text-white text-sp-12 font-semibold',
                  'transition-opacity',
                  canSetActive ? 'hover:opacity-90' : 'opacity-50 cursor-not-allowed'
                )}
              >
                <Check size={12} />
                {isActiveSelected ? 'Active' : 'Set as active'}
              </button>
            </div>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>

      <ConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title="Delete environment"
        description="Are you sure you want to delete this environment? This action cannot be undone and all variables in this environment will be lost."
        confirmText="Delete"
        cancelText="Cancel"
        onConfirm={confirmDeleteEnvironment}
        variant="destructive"
      />
    </DialogPrimitive.Root>
  );
}

export default withErrorBoundary(EnvironmentManager);
