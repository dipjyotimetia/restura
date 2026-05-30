'use client';

import { useMemo, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { cn } from '@/lib/shared/utils';
import { ParamRow, PARAM_GRID, Segmented, SubTabBar } from '@/components/ui/spatial';
import RequestBodyEditor from '@/features/http/components/RequestBodyEditor';
import AuthConfiguration from '@/features/auth/components/AuthConfig';
import ScriptsEditor from '@/features/scripts/components/ScriptsEditor';
import RequestSettingsEditor from '@/features/http/components/RequestSettingsEditor';
import { STANDARD_HTTP_HEADERS, getHeaderDef } from '@/lib/shared/http-headers';
import type { AppSettings, AuthType, BodyType, HttpRequest, KeyValue } from '@/types';
import type { ComboboxSuggestion, ParamRowData } from '@/components/ui/spatial';
import type { useHttpRequestPage } from '@/features/http/hooks/useHttpRequestPage';

const HEADER_KEY_SUGGESTIONS: ReadonlyArray<ComboboxSuggestion> = STANDARD_HTTP_HEADERS.map(
  (h) => ({
    value: h.name,
    ...(h.description !== undefined && { description: h.description }),
  })
);

function headerValueSuggestionsFor(key: string): ReadonlyArray<string> | undefined {
  const def = getHeaderDef(key);
  return def?.values && def.values.length > 0 ? def.values : undefined;
}

type Handlers = ReturnType<typeof useHttpRequestPage>['handlers'];
type SubTabKey = 'params' | 'headers' | 'body' | 'auth' | 'scripts' | 'settings';

interface RequestBuilderTabsProps {
  request: HttpRequest;
  activeTab: SubTabKey;
  onTabChange: (tab: SubTabKey) => void;
  globalSettings: AppSettings;
  counts: { activeParams: number; activeHeaders: number };
  handlers: Handlers;
}

const AUTH_GROUPS: ReadonlyArray<{
  label: string;
  options: ReadonlyArray<{ value: AuthType; label: string }>;
}> = [
  {
    label: 'Common',
    options: [
      { value: 'none', label: 'No Auth' },
      { value: 'bearer', label: 'Bearer' },
      { value: 'basic', label: 'Basic' },
      { value: 'api-key', label: 'API Key' },
    ],
  },
  {
    label: 'OAuth',
    options: [
      { value: 'oauth2', label: 'OAuth 2.0' },
      { value: 'oauth1', label: 'OAuth 1.0' },
    ],
  },
  {
    label: 'Enterprise',
    options: [
      { value: 'aws-signature', label: 'AWS Sig v4' },
      { value: 'digest', label: 'Digest' },
      { value: 'ntlm', label: 'NTLM' },
      { value: 'wsse', label: 'WSSE' },
    ],
  },
];

const AUTH_BADGE: Partial<Record<AuthType, string>> = {
  bearer: 'Bearer',
  basic: 'Basic',
  'api-key': 'API Key',
  oauth2: 'OAuth 2.0',
  oauth1: 'OAuth 1.0',
  'aws-signature': 'AWS',
  digest: 'Digest',
  ntlm: 'NTLM',
  wsse: 'WSSE',
};

// Short tab badge per configured body type — mirrors AUTH_BADGE so the Body
// tab signals "a body is set" without opening it. 'none' intentionally omitted.
const BODY_BADGE: Partial<Record<BodyType, string>> = {
  json: 'JSON',
  'form-data': 'Form',
  'x-www-form-urlencoded': 'Form',
  graphql: 'GQL',
  text: 'Raw',
  binary: 'Bin',
};

const BODY_OPTIONS: ReadonlyArray<{ value: BodyType; label: string }> = [
  { value: 'none', label: 'none' },
  { value: 'json', label: 'JSON' },
  { value: 'form-data', label: 'form-data' },
  { value: 'x-www-form-urlencoded', label: 'x-www-form-urlencoded' },
  { value: 'graphql', label: 'GraphQL' },
  { value: 'text', label: 'raw' },
  { value: 'binary', label: 'binary' },
];

const CONTENT_TYPE_FOR: Partial<Record<BodyType, string>> = {
  json: 'application/json',
  'form-data': 'multipart/form-data',
  'x-www-form-urlencoded': 'application/x-www-form-urlencoded',
  graphql: 'application/json',
  text: 'text/plain',
  binary: 'application/octet-stream',
};

function contentTypeFor(type: BodyType): string {
  return CONTENT_TYPE_FOR[type] ?? '—';
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function toParamRow(kv: KeyValue): ParamRowData {
  const row: ParamRowData = {
    id: kv.id,
    enabled: kv.enabled,
    key: kv.key,
    value: kv.value,
  };
  if (kv.description !== undefined) row.description = kv.description;
  return row;
}

export function RequestBuilderTabs({
  request,
  activeTab,
  onTabChange,
  globalSettings,
  counts,
  handlers,
}: RequestBuilderTabsProps) {
  const paramsCount = counts.activeParams;
  const headersCount = counts.activeHeaders;

  const tabs = useMemo(() => {
    const authBadge = AUTH_BADGE[request.auth.type];
    const bodyBadge = BODY_BADGE[request.body.type];
    const items: Array<{
      value: SubTabKey;
      label: string;
      count?: number;
      badge?: string;
    }> = [
      { value: 'params', label: 'Params' },
      { value: 'headers', label: 'Headers' },
      { value: 'body', label: 'Body' },
      { value: 'auth', label: 'Auth' },
      { value: 'scripts', label: 'Scripts' },
      { value: 'settings', label: 'Settings' },
    ];
    if (paramsCount > 0) items[0]!.count = paramsCount;
    if (headersCount > 0) items[1]!.count = headersCount;
    if (bodyBadge) items[2]!.badge = bodyBadge;
    if (authBadge) items[3]!.badge = authBadge;
    return items;
  }, [paramsCount, headersCount, request.auth.type, request.body.type]);

  const bodyBytes = useMemo(
    () => (request.body.raw ? new Blob([request.body.raw]).size : 0),
    [request.body.raw]
  );

  const variableList = useMemo(() => {
    const matches = new Set<string>();
    const collect = (s?: string) => {
      if (!s) return;
      const re = /\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(s)) !== null) matches.add(m[1]!);
    };
    collect(request.url);
    collect(request.body.raw);
    request.params.forEach((p) => collect(p.value));
    request.headers.forEach((h) => collect(h.value));
    return Array.from(matches);
  }, [request.url, request.body.raw, request.params, request.headers]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <SubTabBar<SubTabKey> tabs={tabs} value={activeTab} onChange={onTabChange} />

      <div className="flex-1 overflow-auto">
        {activeTab === 'params' && (
          <ParamHeaderTable
            rows={request.params.map(toParamRow)}
            onRowChange={(row) =>
              handlers.updateParam(row.id, {
                enabled: row.enabled,
                key: row.key,
                value: row.value,
                ...(row.description !== undefined && { description: row.description }),
              })
            }
            onRowRemove={(id) => handlers.removeParam(id)}
            onAdd={(data) => handlers.addParam(data)}
          />
        )}

        {activeTab === 'headers' && (
          <ParamHeaderTable
            rows={request.headers.map(toParamRow)}
            onRowChange={(row) =>
              handlers.updateHeader(row.id, {
                enabled: row.enabled,
                key: row.key,
                value: row.value,
                ...(row.description !== undefined && { description: row.description }),
              })
            }
            onRowRemove={(id) => handlers.removeHeader(id)}
            onAdd={(data) => handlers.addHeader(data)}
            keySuggestions={HEADER_KEY_SUGGESTIONS}
            valueSuggestionsFor={headerValueSuggestionsFor}
          />
        )}

        {activeTab === 'body' && (
          <div className="p-4 space-y-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <Segmented<BodyType>
                options={BODY_OPTIONS}
                value={request.body.type}
                onChange={handlers.changeBodyType}
                size="sm"
                ariaLabel="Body type"
              />
              {request.body.type !== 'none' && (
                <div className="flex items-center gap-1.5 text-sp-11 text-sp-muted font-mono">
                  <span className="sp-label">Content-Type</span>
                  <span className="text-sp-text/80">{contentTypeFor(request.body.type)}</span>
                </div>
              )}
            </div>

            <div className="rounded-sp-panel border border-sp-line bg-sp-code overflow-hidden">
              <RequestBodyEditor
                body={request.body}
                onBodyTypeChange={handlers.changeBodyType}
                onBodyContentChange={handlers.changeBodyContent}
                url={request.url}
              />
            </div>

            {(bodyBytes > 0 || variableList.length > 0) && (
              <div className="flex items-center justify-between gap-2 px-1 pt-1">
                <div className="flex items-center gap-2 text-sp-11 text-sp-muted font-mono tabular-nums">
                  <span>{formatBytes(bodyBytes)}</span>
                </div>
                {variableList.length > 0 && (
                  <div className="flex items-center gap-1 flex-wrap">
                    <span className="sp-label">Vars</span>
                    {variableList.map((v) => (
                      <span key={v} className="sp-variable font-mono text-sp-11">
                        {`{{${v}}}`}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {activeTab === 'auth' && (
          <div className="grid grid-cols-[190px_1fr] min-h-full">
            <div className="border-r border-sp-line p-2 flex flex-col gap-2 bg-sp-surface-lo/40 overflow-y-auto">
              {AUTH_GROUPS.map((group) => (
                <div key={group.label} className="flex flex-col gap-0.5">
                  <span className="sp-label px-2 py-1">{group.label}</span>
                  {group.options.map((opt) => {
                    const selected = request.auth.type === opt.value;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => handlers.changeAuth({ ...request.auth, type: opt.value })}
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
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
            <div className="p-5 overflow-auto">
              <AuthConfiguration auth={request.auth} onChange={handlers.changeAuth} />
            </div>
          </div>
        )}

        {activeTab === 'scripts' && (
          <div className="p-4">
            <ScriptsEditor
              preRequestScript={request.preRequestScript || ''}
              testScript={request.testScript || ''}
              onPreRequestScriptChange={handlers.changePreRequestScript}
              onTestScriptChange={handlers.changeTestScript}
            />
          </div>
        )}

        {activeTab === 'settings' && (
          <div className="p-4">
            <RequestSettingsEditor
              settings={request.settings}
              globalSettings={globalSettings}
              onSettingsChange={handlers.changeSettings}
              onToggleOverride={handlers.toggleSettingsOverride}
              onProxyOverrideChange={handlers.changeProxyOverride}
            />
          </div>
        )}
      </div>
    </div>
  );
}

interface ParamHeaderTableProps {
  rows: ParamRowData[];
  onRowChange: (row: ParamRowData) => void;
  onRowRemove: (id: string) => void;
  onAdd: (overrides?: Partial<Pick<ParamRowData, 'key' | 'value' | 'description'>>) => void;
  keySuggestions?: ReadonlyArray<ComboboxSuggestion>;
  valueSuggestionsFor?: (key: string) => ReadonlyArray<string> | undefined;
}

const GHOST_FIELDS = [
  { label: 'Key', field: 'key' as const, extraClass: '' },
  { label: 'Value', field: 'value' as const, extraClass: '' },
  { label: 'Description', field: 'desc' as const, extraClass: 'text-sp-11-5 text-sp-muted' },
] as const;

const COLUMN_LABELS = ['KEY', 'VALUE', 'DESCRIPTION'] as const;

function ParamHeaderTable({
  rows,
  onRowChange,
  onRowRemove,
  onAdd,
  keySuggestions,
  valueSuggestionsFor,
}: ParamHeaderTableProps) {
  const [draft, setDraft] = useState({ key: '', value: '', desc: '' });
  const newRowRef = useRef<HTMLInputElement>(null);
  const activeCount = rows.filter((r) => r.enabled && r.key.trim()).length;

  function commitDraft() {
    if (!draft.key.trim() && !draft.value.trim()) return;
    onAdd({
      key: draft.key,
      value: draft.value,
      ...(draft.desc ? { description: draft.desc } : {}),
    });
    setDraft({ key: '', value: '', desc: '' });
    requestAnimationFrame(() => newRowRef.current?.focus());
  }

  function handleGhostKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitDraft();
    }
  }

  function handleGhostBlur(e: React.FocusEvent<HTMLDivElement>) {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      commitDraft();
    }
  }

  const ghostInput =
    'bg-transparent outline-none placeholder:text-sp-dim/50 font-mono text-sp-12 w-full px-2 py-1.5 focus:bg-sp-hover/50 transition-colors';

  return (
    <div>
      {/* Column header */}
      <div
        className="grid items-center border-b border-sp-line bg-sp-surface-lo/30"
        style={{ gridTemplateColumns: PARAM_GRID }}
      >
        <span aria-hidden="true" />
        {COLUMN_LABELS.map((col) => (
          <span
            key={col}
            className="sp-label uppercase tracking-wider text-[10px] px-2 py-2 border-l border-sp-line/40"
          >
            {col}
          </span>
        ))}
        <span aria-hidden="true" />
      </div>

      {/* Rows */}
      <div role="rowgroup">
        {rows.map((row, i) => (
          <ParamRow
            key={row.id}
            row={row}
            onChange={onRowChange}
            onRemove={onRowRemove}
            showVariableHighlight
            inputRef={i === rows.length - 1 ? newRowRef : undefined}
            {...(keySuggestions && { keySuggestions })}
            {...(valueSuggestionsFor && { valueSuggestionsFor })}
          />
        ))}
      </div>

      {/* Ghost row — always-visible add affordance */}
      <div
        className="grid items-stretch border-b border-sp-line/50 opacity-40 focus-within:opacity-75 transition-opacity"
        style={{ gridTemplateColumns: PARAM_GRID }}
        onBlur={handleGhostBlur}
        onKeyDown={handleGhostKeyDown}
      >
        <div className="flex items-center justify-center">
          <span aria-hidden="true" className="h-3 w-3 rounded-full border border-sp-line/60" />
        </div>
        {GHOST_FIELDS.map(({ label, field, extraClass }) => (
          <div key={field} className="border-l border-sp-line/40 min-w-0">
            <input
              value={draft[field]}
              onChange={(e) => setDraft((d) => ({ ...d, [field]: e.target.value }))}
              placeholder={label}
              className={cn(ghostInput, extraClass)}
              aria-label={`New entry ${label.toLowerCase()}`}
            />
          </div>
        ))}
        <div />
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between px-3 py-2">
        <button
          type="button"
          onClick={() => onAdd()}
          className={cn(
            'inline-flex items-center gap-1 text-sp-11 text-sp-dim',
            'hover:text-sp-accent transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent/40 rounded-sp-chip'
          )}
        >
          <Plus size={11} />
          <span>Add row</span>
        </button>
        {rows.length > 0 && (
          <span className="text-sp-11 text-sp-dim font-mono tabular-nums">
            {activeCount} of {rows.length} active
          </span>
        )}
      </div>
    </div>
  );
}
