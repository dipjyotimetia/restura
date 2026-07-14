'use client';

import { ChevronDown, ChevronRight, Layers, Loader2, RefreshCw, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Floater, TextField } from '@/components/ui/spatial';
import { getRootTypes, getTypeFields, getTypesByKind } from '../lib/introspection';
import type { GraphQLSchema, GraphQLTypeKind } from '../types';
import { formatTypeRef } from '../types';

interface SchemaExplorerProps {
  schema: GraphQLSchema | null;
  onFieldSelect?: (field: string) => void;
  onRefresh?: () => void;
  loading?: boolean;
  loaded?: boolean;
}

type Kind = 'OBJECT' | 'ENUM' | 'SCALAR' | 'INPUT' | 'INTERFACE';

// Kind badge palette per design handoff §6.
const KIND_COLOR: Record<Kind, string> = {
  OBJECT: '#79b8ff',
  ENUM: '#ffab70',
  SCALAR: 'var(--color-success)',
  INPUT: 'var(--color-proto-ws)',
  INTERFACE: 'var(--color-info)',
};

function kindFor(typeKind: GraphQLTypeKind): Kind {
  switch (typeKind) {
    case 'OBJECT':
      return 'OBJECT';
    case 'ENUM':
      return 'ENUM';
    case 'SCALAR':
      return 'SCALAR';
    case 'INPUT_OBJECT':
      return 'INPUT';
    case 'INTERFACE':
      return 'INTERFACE';
    default:
      return 'OBJECT';
  }
}

function KindBadge({ kind }: { kind: Kind }) {
  const color = KIND_COLOR[kind];
  return (
    <span
      className="inline-flex items-center justify-center px-1.5 h-[16px] rounded-[4px] font-mono font-bold tracking-wider"
      style={{
        color,
        background: `color-mix(in srgb, ${color} 13%, transparent)`,
        fontSize: '9px',
        letterSpacing: '0.05em',
      }}
    >
      {kind}
    </span>
  );
}

function LoadedPill() {
  return (
    <span
      className="sp-label inline-flex items-center px-[5px] py-[1px] rounded-[4px]"
      style={{
        color: 'var(--color-success)',
        background: 'color-mix(in srgb, var(--color-success) 16%, transparent)',
        letterSpacing: '0.05em',
      }}
    >
      LOADED
    </span>
  );
}

export default function SchemaExplorer({
  schema,
  onFieldSelect,
  onRefresh,
  loading = false,
  loaded = false,
}: SchemaExplorerProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedTypes, setExpandedTypes] = useState<Set<string>>(new Set());

  const filterBySearch = (name: string) => {
    if (!searchQuery) return true;
    return name.toLowerCase().includes(searchQuery.toLowerCase());
  };

  const sections = useMemo(() => {
    if (!schema) return null;
    const roots = getRootTypes(schema);
    const rootNames = new Set(
      [roots.query, roots.mutation, roots.subscription].filter((n): n is string => Boolean(n))
    );

    type Row = {
      name: string;
      kind: Kind;
      isRoot?: 'query' | 'mutation' | 'subscription';
    };

    const rows: Row[] = [];
    if (roots.query) rows.push({ name: roots.query, kind: 'OBJECT', isRoot: 'query' });
    if (roots.mutation) rows.push({ name: roots.mutation, kind: 'OBJECT', isRoot: 'mutation' });
    if (roots.subscription)
      rows.push({ name: roots.subscription, kind: 'OBJECT', isRoot: 'subscription' });

    const pushKind = (k: GraphQLTypeKind) => {
      for (const t of getTypesByKind(schema, k)) {
        if (!t.name || rootNames.has(t.name)) continue;
        rows.push({ name: t.name, kind: kindFor(t.kind) });
      }
    };

    pushKind('OBJECT');
    pushKind('INTERFACE');
    pushKind('INPUT_OBJECT');
    pushKind('ENUM');
    pushKind('SCALAR');

    return rows;
  }, [schema]);

  const toggleType = (typeName: string) => {
    setExpandedTypes((prev) => {
      const next = new Set(prev);
      if (next.has(typeName)) next.delete(typeName);
      else next.add(typeName);
      return next;
    });
  };

  return (
    <Floater
      radius="panel"
      elevation="float"
      className="w-[220px] shrink-0 flex flex-col overflow-hidden"
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 h-10 border-b border-sp-line shrink-0">
        <Layers className="h-3.5 w-3.5" style={{ color: 'var(--sp-accent)' }} />
        <span className="text-sp-13 font-semibold text-sp-text">Schema</span>
        {loaded && <LoadedPill />}
        <div className="ml-auto">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onRefresh}
            disabled={loading || !onRefresh}
            className="h-6 w-6 p-0 text-sp-muted hover:text-sp-text"
            aria-label="Refresh schema"
          >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
      </div>

      {/* Filter */}
      <div className="px-2 py-2 border-b border-sp-line shrink-0">
        <TextField
          size="sm"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Filter types…"
          leadingIcon={<Search className="h-3 w-3" />}
          className="w-full"
        />
      </div>

      {/* Empty state */}
      {!schema && (
        <div className="flex-1 flex items-center justify-center px-4 py-8 text-center">
          <p className="text-sp-12 text-sp-muted">
            {loading ? 'Loading schema…' : 'No schema loaded. Hit refresh to introspect.'}
          </p>
        </div>
      )}

      {/* Types list */}
      {schema && sections && (
        <ScrollArea className="flex-1">
          <div className="px-2 py-2 flex flex-col gap-0.5">
            {sections
              .filter((row) => {
                if (!searchQuery) return true;
                if (filterBySearch(row.name)) return true;
                // also match if any field matches
                const fields = getTypeFields(schema, row.name);
                return fields.some((f) => filterBySearch(f.name));
              })
              .map((row) => {
                const fields = getTypeFields(schema, row.name);
                const filteredFields = fields.filter((f) =>
                  searchQuery ? filterBySearch(f.name) || filterBySearch(row.name) : true
                );
                const isExpanded =
                  expandedTypes.has(row.name) ||
                  (searchQuery.length > 0 && filteredFields.length > 0);
                const hasFields = fields.length > 0;

                return (
                  <div key={row.name} className="flex flex-col">
                    <button
                      type="button"
                      onClick={() => toggleType(row.name)}
                      className="flex items-center gap-1.5 w-full text-left px-1.5 h-6 rounded-sp-chip hover:bg-sp-hover transition-colors"
                    >
                      {hasFields ? (
                        isExpanded ? (
                          <ChevronDown className="h-3 w-3 text-sp-dim shrink-0" />
                        ) : (
                          <ChevronRight className="h-3 w-3 text-sp-dim shrink-0" />
                        )
                      ) : (
                        <span className="w-3 shrink-0" />
                      )}
                      <KindBadge kind={row.kind} />
                      <span className="font-mono text-sp-12 text-sp-text truncate">{row.name}</span>
                      {row.isRoot && (
                        <span className="sp-label ml-auto" style={{ fontSize: '8.5px' }}>
                          {row.isRoot}
                        </span>
                      )}
                    </button>

                    {isExpanded && hasFields && (
                      <div className="ml-4 pl-2 border-l border-sp-line flex flex-col gap-0.5 mt-0.5 mb-1">
                        {filteredFields.map((field) => (
                          <button
                            key={field.name}
                            type="button"
                            onClick={() => onFieldSelect?.(field.name)}
                            className="flex items-center justify-between gap-2 w-full text-left px-1.5 h-5 rounded-sp-chip hover:bg-sp-hover transition-colors"
                          >
                            <span className="font-mono text-sp-11 text-sp-text truncate">
                              {field.name}
                            </span>
                            <span className="font-mono text-sp-11 text-sp-dim truncate">
                              {formatTypeRef(field.type)}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
        </ScrollArea>
      )}
    </Floater>
  );
}
