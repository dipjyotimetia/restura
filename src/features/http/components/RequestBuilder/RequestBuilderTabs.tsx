'use client';

import { useMemo } from 'react';
import { Plus } from 'lucide-react';
import { cn } from '@/lib/shared/utils';
import {
  ParamRow,
  Segmented,
  SubTabBar,
} from '@/components/ui/spatial';
import RequestBodyEditor from '@/features/http/components/RequestBodyEditor';
import AuthConfiguration from '@/features/auth/components/AuthConfig';
import ScriptsEditor from '@/features/scripts/components/ScriptsEditor';
import RequestSettingsEditor from '@/features/http/components/RequestSettingsEditor';
import type {
  AppSettings,
  AuthType,
  BodyType,
  HttpRequest,
  KeyValue,
} from '@/types';
import type { ParamRowData } from '@/components/ui/spatial';
import type { useHttpRequestPage } from '@/features/http/hooks/useHttpRequestPage';

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

const AUTH_OPTIONS: ReadonlyArray<{ value: AuthType; label: string }> = [
  { value: 'none', label: 'No Auth' },
  { value: 'bearer', label: 'Bearer' },
  { value: 'basic', label: 'Basic' },
  { value: 'api-key', label: 'API Key' },
  { value: 'oauth2', label: 'OAuth 2.0' },
  { value: 'oauth1', label: 'OAuth 1.0' },
  { value: 'aws-signature', label: 'AWS Sig v4' },
  { value: 'digest', label: 'Digest' },
  { value: 'ntlm', label: 'NTLM' },
  { value: 'wsse', label: 'WSSE' },
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

const BODY_OPTIONS: ReadonlyArray<{ value: BodyType; label: string }> = [
  { value: 'none', label: 'none' },
  { value: 'json', label: 'JSON' },
  { value: 'form-data', label: 'form-data' },
  { value: 'x-www-form-urlencoded', label: 'x-www-form-urlencoded' },
  { value: 'graphql', label: 'GraphQL' },
  { value: 'text', label: 'raw' },
  { value: 'binary', label: 'binary' },
];

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

  const tabs = useMemo(
    () => {
      const authBadge = AUTH_BADGE[request.auth.type];
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
      if (authBadge) items[3]!.badge = authBadge;
      return items;
    },
    [paramsCount, headersCount, request.auth.type]
  );

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
      <SubTabBar<SubTabKey>
        tabs={tabs}
        value={activeTab}
        onChange={onTabChange}
      />

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
          />
        )}

        {activeTab === 'body' && (
          <div className="p-4 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <Segmented<BodyType>
                options={BODY_OPTIONS}
                value={request.body.type}
                onChange={handlers.changeBodyType}
                size="sm"
                ariaLabel="Body type"
              />
              <span className="sp-label">CONTENT-TYPE AUTO</span>
            </div>

            <div className="rounded-sp-panel border border-sp-line bg-sp-code overflow-hidden">
              <RequestBodyEditor
                body={request.body}
                onBodyTypeChange={handlers.changeBodyType}
                onBodyContentChange={handlers.changeBodyContent}
                url={request.url}
              />
            </div>

            <div className="flex items-center justify-between gap-2 px-1 pt-1">
              <div className="flex items-center gap-3 text-sp-11 text-sp-muted font-mono tabular-nums">
                <span>{bodyBytes} bytes</span>
                <span className="text-sp-dim">·</span>
                <span>{request.body.type}</span>
              </div>
              {variableList.length > 0 && (
                <div className="flex items-center gap-1 flex-wrap">
                  <span className="sp-label">VARS</span>
                  {variableList.map((v) => (
                    <span key={v} className="sp-variable font-mono text-sp-11">
                      {`{{${v}}}`}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'auth' && (
          <div className="grid grid-cols-[180px_1fr] min-h-full">
            <div className="border-r border-sp-line p-2 flex flex-col gap-0.5">
              <span className="sp-label px-2 py-1.5">AUTH TYPE</span>
              {AUTH_OPTIONS.map((opt) => {
                const selected = request.auth.type === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() =>
                      handlers.changeAuth({ ...request.auth, type: opt.value })
                    }
                    className={cn(
                      'relative text-left px-3 py-1.5 rounded-sp-btn text-sp-12 transition-colors',
                      'hover:bg-sp-hover',
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
            <div className="p-4 overflow-auto">
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
}

function ParamHeaderTable({
  rows,
  onRowChange,
  onRowRemove,
  onAdd,
  addLabel,
}: ParamHeaderTableProps) {
  return (
    <div className="p-3">
      <div
        className="grid items-center gap-2 px-2 py-1.5 border-b border-sp-line"
        style={{ gridTemplateColumns: '28px 1fr 1.5fr 1fr 22px' }}
      >
        <span aria-hidden="true" />
        <span className="sp-label">KEY</span>
        <span className="sp-label">VALUE</span>
        <span className="sp-label">DESCRIPTION</span>
        <span aria-hidden="true" />
      </div>

      <div role="rowgroup">
        {rows.length === 0 ? (
          <div className="px-2 py-6 text-center text-sp-muted text-sp-12">
            No entries
          </div>
        ) : (
          rows.map((row) => (
            <ParamRow
              key={row.id}
              row={row}
              onChange={onRowChange}
              onRemove={onRowRemove}
              showVariableHighlight
            />
          ))
        )}
      </div>

      <button
        type="button"
        onClick={onAdd}
        className={cn(
          'mt-3 inline-flex items-center gap-1.5 h-7 px-2.5 rounded-sp-btn',
          'border border-dashed border-sp-line-strong text-sp-muted',
          'hover:text-sp-text hover:border-sp-accent hover:bg-sp-hover transition-colors',
          'text-sp-12 font-medium'
        )}
      >
        <Plus size={14} />
        <span>+ {addLabel}</span>
      </button>
    </div>
  );
}

