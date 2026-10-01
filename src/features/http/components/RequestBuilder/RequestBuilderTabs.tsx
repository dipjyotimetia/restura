'use client';

import { Plus, WandSparkles } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { v4 as uuidv4 } from 'uuid';
import { Button } from '@/components/ui/button';
import type { ComboboxSuggestion, ParamRowData, VariableStatus } from '@/components/ui/spatial';
import {
  ComboboxInput,
  PARAM_GRID,
  ParamRow,
  Segmented,
  SubTabBar,
  SubTabPanel,
} from '@/components/ui/spatial';
import AuthConfiguration from '@/features/auth/components/AuthConfig';
import {
  authTypeLabel,
  InheritedAuthHint,
  useInheritedAuth,
} from '@/features/auth/components/InheritedAuthHint';
import RequestBodyEditor, { bodyEditorFills } from '@/features/http/components/RequestBodyEditor';
import RequestSettingsEditor from '@/features/http/components/RequestSettingsEditor';
import type { useHttpRequestPage } from '@/features/http/hooks/useHttpRequestPage';
import { fromBulkText, toBulkText } from '@/features/http/lib/bulkEdit';
import { formatJsonBody } from '@/features/http/lib/formatJsonBody';
import ScriptsEditor from '@/features/scripts/components/ScriptsEditor';
import { useVariableStatus } from '@/hooks/useVariableStatus';
import { getHeaderDef, STANDARD_HTTP_HEADERS } from '@/lib/shared/http-headers';
import { cn } from '@/lib/shared/utils';
import { findVariableTokens } from '@/lib/shared/variableTokens';
import type { AppSettings, AuthType, BodyType, HttpRequest, KeyValue } from '@/types';

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
  xml: 'XML',
  binary: 'Bin',
};

const BODY_OPTIONS: ReadonlyArray<{ value: BodyType; label: string }> = [
  { value: 'none', label: 'none' },
  { value: 'json', label: 'JSON' },
  { value: 'form-data', label: 'form-data' },
  { value: 'x-www-form-urlencoded', label: 'x-www-form-urlencoded' },
  { value: 'graphql', label: 'GraphQL' },
  { value: 'text', label: 'raw' },
  { value: 'xml', label: 'XML' },
  { value: 'binary', label: 'binary' },
];

const CONTENT_TYPE_FOR: Partial<Record<BodyType, string>> = {
  json: 'application/json',
  'form-data': 'multipart/form-data',
  'x-www-form-urlencoded': 'application/x-www-form-urlencoded',
  graphql: 'application/json',
  text: 'text/plain',
  xml: 'application/xml',
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
  const getVarStatus = useVariableStatus();

  const inheritedAuth = useInheritedAuth(request);
  const tabs = useMemo(() => {
    // An inherited auth still goes out with the request, so badge it too.
    const authBadge =
      AUTH_BADGE[request.auth.type] ??
      (inheritedAuth
        ? `↑ ${AUTH_BADGE[inheritedAuth.auth.type] ?? inheritedAuth.auth.type}`
        : undefined);
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
  }, [paramsCount, headersCount, request.auth.type, request.body.type, inheritedAuth]);

  const bodyBytes = useMemo(
    () => (request.body.raw ? new Blob([request.body.raw]).size : 0),
    [request.body.raw]
  );

  const variableList = useMemo(() => {
    const matches = new Set<string>();
    const collect = (s?: string) => {
      if (!s) return;
      for (const token of findVariableTokens(s)) matches.add(token.name);
    };
    collect(request.url);
    collect(request.body.raw);
    request.params.forEach((p) => collect(p.value));
    request.headers.forEach((h) => collect(h.value));
    return Array.from(matches);
  }, [request.url, request.body.raw, request.params, request.headers]);

  const bodyFills = bodyEditorFills(request.body.type);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <SubTabBar<SubTabKey> tabs={tabs} value={activeTab} onChange={onTabChange} />

      <SubTabPanel tabKey={activeTab} className="flex-1 overflow-auto">
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
            source={request.params}
            onReplaceAll={handlers.replaceParams}
            itemLabel="parameter"
            getStatus={getVarStatus}
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
            source={request.headers}
            onReplaceAll={handlers.replaceHeaders}
            itemLabel="header"
            keySuggestions={HEADER_KEY_SUGGESTIONS}
            valueSuggestionsFor={headerValueSuggestionsFor}
            getStatus={getVarStatus}
          />
        )}

        {activeTab === 'body' && (
          <div
            className={cn(
              'p-4 flex flex-col gap-3',
              // Only the code editor fills the panel height; content-sized body
              // types keep auto height so the parent scroll container handles
              // overflow (e.g. many form-data rows) instead of clipping.
              bodyFills && 'h-full min-h-0'
            )}
          >
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <Segmented<BodyType>
                options={BODY_OPTIONS}
                value={request.body.type}
                onChange={handlers.changeBodyType}
                size="sm"
                ariaLabel="Body type"
              />
              <div className="flex items-center gap-3">
                {request.body.type === 'json' && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1.5 text-sp-11"
                    disabled={!request.body.raw?.trim()}
                    onClick={() => {
                      const formatted = formatJsonBody(request.body.raw ?? '');
                      if (formatted === null) toast.error('The body isn’t valid JSON');
                      else handlers.changeBodyContent(formatted);
                    }}
                  >
                    <WandSparkles className="h-3.5 w-3.5" aria-hidden="true" />
                    Beautify
                  </Button>
                )}
                {request.body.type !== 'none' && (
                  <div className="flex items-center gap-1.5 text-sp-11 text-sp-muted font-mono">
                    <span className="sp-label">Content-Type</span>
                    <span className="text-sp-text/80">{contentTypeFor(request.body.type)}</span>
                  </div>
                )}
              </div>
            </div>

            <div
              className={cn(
                'rounded-sp-panel border border-sp-line bg-sp-code overflow-hidden',
                // Let the code editor fill the panel; content-sized body types
                // (empty state, form-data list, binary picker) stay natural height.
                bodyFills && 'flex-1 min-h-0'
              )}
            >
              <RequestBodyEditor
                body={request.body}
                onBodyTypeChange={handlers.changeBodyType}
                onBodyContentChange={handlers.changeBodyContent}
                onFormDataChange={handlers.changeFormData}
                onUrlEncodedChange={handlers.changeUrlEncoded}
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
                    {variableList.map((v) => {
                      const unresolved = getVarStatus(v) === 'unresolved';
                      return (
                        <span
                          key={v}
                          className={cn(
                            'font-mono text-sp-11',
                            unresolved ? 'sp-variable-unresolved' : 'sp-variable'
                          )}
                          title={unresolved ? `Unresolved variable: ${v}` : undefined}
                        >
                          {`{{${v}}}`}
                        </span>
                      );
                    })}
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
                        {/* 'No Auth' means "inherit" when a parent defines auth. */}
                        {opt.value === 'none' && inheritedAuth
                          ? `Inherit (${authTypeLabel(inheritedAuth.auth.type)})`
                          : opt.label}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
            <div className="p-5 overflow-auto">
              <InheritedAuthHint request={request} />
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
      </SubTabPanel>
    </div>
  );
}

interface ParamHeaderTableProps {
  rows: ParamRowData[];
  onRowChange: (row: ParamRowData) => void;
  onRowRemove: (id: string) => void;
  onAdd: (overrides?: Partial<Pick<ParamRowData, 'key' | 'value' | 'description'>>) => void;
  /** The stored rows, for bulk edit (keeps descriptions/ids across the text round-trip). */
  source: KeyValue[];
  onReplaceAll: (rows: KeyValue[]) => void;
  /** Singular noun for accessible names, e.g. 'parameter' or 'header'. */
  itemLabel: string;
  keySuggestions?: ReadonlyArray<ComboboxSuggestion>;
  valueSuggestionsFor?: (key: string) => ReadonlyArray<string> | undefined;
  getStatus?: (varName: string) => VariableStatus;
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
  source,
  onReplaceAll,
  itemLabel,
  keySuggestions,
  valueSuggestionsFor,
  getStatus,
}: ParamHeaderTableProps) {
  const [draft, setDraft] = useState({ key: '', value: '', desc: '' });
  // Bulk edit: null = table view; otherwise the text being edited.
  const [bulkText, setBulkText] = useState<string | null>(null);
  const applyBulk = () => {
    if (bulkText !== null) onReplaceAll(fromBulkText(bulkText, source, uuidv4));
    setBulkText(null);
  };
  const newRowRef = useRef<HTMLInputElement>(null);
  // Set when a commit should pull focus into the freshly-added row (Enter only,
  // never blur — a blur commit means the user is leaving, so stealing focus
  // would hijack wherever they clicked).
  const focusNewRow = useRef(false);
  const prevRowCount = useRef(rows.length);
  const activeCount = rows.filter((r) => r.enabled && r.key.trim()).length;

  // Focus the appended row's key input once it has actually rendered. Keyed on
  // the row count growing rather than a single requestAnimationFrame, so it
  // survives deferred store updates and concurrent rendering.
  useEffect(() => {
    if (rows.length > prevRowCount.current && focusNewRow.current) {
      newRowRef.current?.focus();
    }
    focusNewRow.current = false;
    prevRowCount.current = rows.length;
  }, [rows.length]);

  function commitDraft(refocus: boolean) {
    if (!draft.key.trim() && !draft.value.trim()) return;
    focusNewRow.current = refocus;
    onAdd({
      key: draft.key,
      value: draft.value,
      ...(draft.desc ? { description: draft.desc } : {}),
    });
    setDraft({ key: '', value: '', desc: '' });
  }

  function handleGhostKeyDown(e: React.KeyboardEvent) {
    // A defaultPrevented Enter means a ComboboxInput consumed it to pick a
    // suggestion — the user is still composing the row, so don't commit yet.
    if (e.key === 'Enter' && !e.defaultPrevented) {
      e.preventDefault();
      commitDraft(true);
    }
  }

  function handleGhostBlur(e: React.FocusEvent<HTMLDivElement>) {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      commitDraft(false);
    }
  }

  const ghostInput =
    'bg-transparent outline-none placeholder:text-sp-dim/50 font-mono text-sp-12 w-full px-2 py-1.5 focus:bg-sp-hover/50 transition-colors';

  return (
    <div className="relative flex flex-col h-full min-h-0">
      {/* Column header — pinned */}
      <div
        className="grid items-center border-b border-sp-line bg-sp-surface-lo/30 flex-none"
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

      {/* Scrollable rows + ghost row — only this region scrolls, so the header
          and footer stay pinned and never clip against the panel edge. */}
      <div className="flex-1 overflow-auto min-h-0">
        <div role="rowgroup">
          {rows.map((row, i) => (
            <ParamRow
              key={row.id}
              row={row}
              onChange={onRowChange}
              onRemove={onRowRemove}
              itemLabel={itemLabel}
              showVariableHighlight
              {...(getStatus && { getStatus })}
              {...(i === rows.length - 1 && { inputRef: newRowRef })}
              {...(keySuggestions && { keySuggestions })}
              {...(valueSuggestionsFor && { valueSuggestionsFor })}
            />
          ))}
        </div>

        {/*
          Ghost row — always-visible add affordance. Drafts get the same
          key/value autocomplete as committed rows (that's when suggestions
          matter most — while typing the new header); variable highlighting
          still applies only once the row is committed above.
        */}
        {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- container delegates blur/keydown from the nested ghost-row inputs */}
        <div
          className="grid items-stretch border-b border-sp-line/50 opacity-40 focus-within:opacity-75 transition-opacity"
          style={{ gridTemplateColumns: PARAM_GRID }}
          onBlur={handleGhostBlur}
          onKeyDown={handleGhostKeyDown}
        >
          <div className="flex items-center justify-center">
            <span aria-hidden="true" className="h-3 w-3 rounded-full border border-sp-line/60" />
          </div>
          {GHOST_FIELDS.map(({ label, field, extraClass }) => {
            const suggestions =
              field === 'key'
                ? keySuggestions
                : field === 'value'
                  ? valueSuggestionsFor?.(draft.key)?.map((v) => ({ value: v }))
                  : undefined;
            return (
              <div key={field} className="border-l border-sp-line/40 min-w-0">
                {suggestions && suggestions.length > 0 ? (
                  <ComboboxInput
                    value={draft[field]}
                    onChange={(val) => setDraft((d) => ({ ...d, [field]: val }))}
                    suggestions={suggestions}
                    placeholder={label}
                    inputClassName={cn(ghostInput, extraClass)}
                    aria-label={`New entry ${label.toLowerCase()}`}
                  />
                ) : (
                  <input
                    value={draft[field]}
                    onChange={(e) => setDraft((d) => ({ ...d, [field]: e.target.value }))}
                    placeholder={label}
                    className={cn(ghostInput, extraClass)}
                    aria-label={`New entry ${label.toLowerCase()}`}
                  />
                )}
              </div>
            );
          })}
          <div />
        </div>
      </div>

      {bulkText !== null && (
        <div className="absolute inset-0 top-9 bottom-10 z-10 flex flex-col bg-sp-surface p-2">
          <textarea
            autoFocus
            aria-label={`Bulk edit ${itemLabel}s`}
            value={bulkText}
            onChange={(e) => setBulkText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                setBulkText(null);
              }
            }}
            spellCheck={false}
            placeholder={'key: value\n//disabled-key: value'}
            className="flex-1 resize-none rounded-sp-btn border border-sp-line bg-sp-code p-2 font-mono text-sp-12 text-sp-text outline-none focus-visible:ring-2 focus-visible:ring-sp-accent"
          />
          <p className="mt-1 text-sp-11 text-sp-dim">
            One <code className="font-mono">key: value</code> per line; prefix with{' '}
            <code className="font-mono">//</code> to disable.
          </p>
        </div>
      )}

      {/* Footer — pinned */}
      <div className="flex items-center justify-between px-3 py-2 border-t border-sp-line/50 flex-none">
        {bulkText !== null ? (
          <div className="flex items-center gap-2">
            <Button size="sm" className="h-7" onClick={applyBulk}>
              Apply
            </Button>
            <Button size="sm" variant="ghost" className="h-7" onClick={() => setBulkText(null)}>
              Cancel
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-3">
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
            <button
              type="button"
              onClick={() => setBulkText(toBulkText(source))}
              className={cn(
                'text-sp-11 text-sp-dim hover:text-sp-accent transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent/40 rounded-sp-chip'
              )}
            >
              Bulk edit
            </button>
          </div>
        )}
        {rows.length > 0 && (
          <span className="text-sp-11 text-sp-dim font-mono tabular-nums">
            {activeCount} of {rows.length} active
          </span>
        )}
      </div>
    </div>
  );
}
