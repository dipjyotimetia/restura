'use client';

import { useMemo } from 'react';
import { Plus } from 'lucide-react';
import { cn } from '@/lib/shared/utils';
import { ParamRow, Segmented, SubTabBar } from '@/components/ui/spatial';
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
            onAdd={() => handlers.addParam()}
            addLabel="Add parameter"
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
            onAdd={() => handlers.addHeader()}
            addLabel="Add header"
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
  onAdd: () => void;
  addLabel: string;
  keySuggestions?: ReadonlyArray<ComboboxSuggestion>;
  valueSuggestionsFor?: (key: string) => ReadonlyArray<string> | undefined;
}

function ParamHeaderTable({
  rows,
  onRowChange,
  onRowRemove,
  onAdd,
  addLabel,
  keySuggestions,
  valueSuggestionsFor,
}: ParamHeaderTableProps) {
  const activeCount = rows.filter((r) => r.enabled && r.key.trim()).length;
  return (
    <div className="p-3">
      <div
        className="grid items-center gap-2 px-2 py-1.5 border-b border-sp-line"
        style={{ gridTemplateColumns: '28px 1fr 1.5fr 1fr 22px' }}
      >
        <span aria-hidden="true" />
        <span className="sp-label">Key</span>
        <span className="sp-label">Value</span>
        <span className="sp-label">Description</span>
        <span aria-hidden="true" />
      </div>

      <div role="rowgroup">
        {rows.length === 0 ? (
          <div className="px-2 py-10 text-center">
            <div className="mx-auto mb-2 inline-flex items-center justify-center h-8 w-8 rounded-full bg-sp-surface-lo text-sp-dim">
              <Plus size={16} />
            </div>
            <p className="text-sp-12 text-sp-muted">No entries yet</p>
            <p className="text-sp-11 text-sp-dim mt-0.5">
              Click <span className="text-sp-muted font-medium">{addLabel}</span> below to start.
            </p>
          </div>
        ) : (
          rows.map((row) => (
            <ParamRow
              key={row.id}
              row={row}
              onChange={onRowChange}
              onRemove={onRowRemove}
              showVariableHighlight
              {...(keySuggestions && { keySuggestions })}
              {...(valueSuggestionsFor && { valueSuggestionsFor })}
            />
          ))
        )}
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={onAdd}
          className={cn(
            'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-sp-btn',
            'border border-dashed border-sp-line-strong text-sp-muted',
            'hover:text-sp-text hover:border-sp-accent hover:bg-sp-hover transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent/40',
            'text-sp-12 font-medium'
          )}
        >
          <Plus size={14} />
          <span>{addLabel}</span>
        </button>
        {rows.length > 0 && (
          <span className="text-sp-11 text-sp-dim font-mono tabular-nums">
            {activeCount} active · {rows.length} total
          </span>
        )}
      </div>
    </div>
  );
}
