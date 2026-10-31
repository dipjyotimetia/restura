'use client';

import {
  ChevronDown,
  ChevronRight,
  FileUp,
  Layers,
  Loader2,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Floater, TextField } from '@/components/ui/spatial';
import { getRootTypes, getTypeByName, getTypesByKind } from '../lib/introspection';
import type { GraphQLSchema, GraphQLTypeKind, GraphQLTypeRef } from '../types';
import { formatTypeRef } from '../types';

/** A field (object/interface) or input field (input object) row. */
interface Member {
  name: string;
  type: GraphQLTypeRef;
  isDeprecated?: boolean;
  deprecationReason?: string | null;
}

/** Fields of an output type, or input fields of an input object. */
function getMembers(schema: GraphQLSchema, typeName: string): Member[] {
  const type = getTypeByName(schema, typeName);
  if (!type) return [];
  return type.kind === 'INPUT_OBJECT' ? (type.inputFields ?? []) : (type.fields ?? []);
}

function MemberName({ member }: { member: Member }) {
  const deprecated = member.isDeprecated === true;
  return (
    <span
      className={`font-mono text-sp-11 truncate ${deprecated ? 'text-sp-dim line-through' : 'text-sp-text'}`}
      title={
        deprecated
          ? member.deprecationReason
            ? `Deprecated: ${member.deprecationReason}`
            : 'Deprecated'
          : undefined
      }
    >
      {member.name}
    </span>
  );
}

interface SchemaExplorerProps {
  schema: GraphQLSchema | null;
  onFieldSelect?: (field: string) => void;
  onRefresh?: () => void;
  /** Opens the Load schema dialog (SDL / introspection JSON). */
  onImport?: () => void;
  /** Drops the request's imported schema (falls back to introspection). */
  onClearImported?: () => void;
  loading?: boolean;
  loaded?: boolean;
  /**
   * Provenance of the request's imported schema (e.g. "From api.graphqls").
   * Set only when the schema shown was imported by hand.
   */
  importedFrom?: string | undefined;
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

function KindBadge({ kind }: { kind: Kind }) {
  const color = KIND_COLOR[kind];
  return (
    <span
      className="inline-flex items-center justify-center px-1.5 h-[16px] rounded-[4px] font-mono font-bold"
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

function StatusPill({ label, color }: { label: string; color: string }) {
  return (
    <span
      className="sp-label inline-flex items-center px-[5px] py-[1px] rounded-[4px]"
      style={{
        color,
        background: `color-mix(in srgb, ${color} 16%, transparent)`,
        letterSpacing: '0.05em',
      }}
    >
      {label}
    </span>
  );
}

export default function SchemaExplorer({
  schema,
  onFieldSelect,
  onRefresh,
  onImport,
  onClearImported,
  loading = false,
  loaded = false,
  importedFrom,
}: SchemaExplorerProps) {
  const imported = importedFrom !== undefined;
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
      /** `@oneOf` input objects / `@specifiedBy` scalars (extended introspection). */
      tag?: { label: string; title: string };
    };

    const rows: Row[] = [];
    if (roots.query) rows.push({ name: roots.query, kind: 'OBJECT', isRoot: 'query' });
    if (roots.mutation) rows.push({ name: roots.mutation, kind: 'OBJECT', isRoot: 'mutation' });
    if (roots.subscription)
      rows.push({ name: roots.subscription, kind: 'OBJECT', isRoot: 'subscription' });

    const pushKind = (typeKind: GraphQLTypeKind, kind: Kind) => {
      for (const t of getTypesByKind(schema, typeKind)) {
        if (!t.name || rootNames.has(t.name)) continue;
        const row: Row = { name: t.name, kind };
        if (t.isOneOf) {
          row.tag = { label: '@oneOf', title: 'Exactly one field must be provided' };
        } else if (t.specifiedByURL) {
          row.tag = { label: '@specifiedBy', title: t.specifiedByURL };
        }
        rows.push(row);
      }
    };

    pushKind('OBJECT', 'OBJECT');
    pushKind('INTERFACE', 'INTERFACE');
    pushKind('INPUT_OBJECT', 'INPUT');
    pushKind('ENUM', 'ENUM');
    pushKind('SCALAR', 'SCALAR');

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
        {imported ? (
          <StatusPill label="IMPORTED" color="var(--color-info)" />
        ) : (
          loaded && <StatusPill label="LOADED" color="var(--color-success)" />
        )}
        <div className="ml-auto flex items-center gap-0.5">
          {onImport && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={onImport}
              className="h-6 w-6 p-0 text-sp-muted hover:text-sp-text"
              aria-label="Load schema file or SDL"
              title="Load schema (SDL / introspection JSON)"
            >
              <FileUp className="h-3.5 w-3.5" />
            </Button>
          )}
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

      {imported && (
        <div className="flex items-center gap-1 px-3 h-7 border-b border-sp-line shrink-0 text-sp-11 text-sp-muted">
          <span className="truncate" title={importedFrom}>
            {importedFrom}
          </span>
          {onClearImported && (
            <button
              type="button"
              onClick={onClearImported}
              className="ml-auto inline-flex items-center gap-0.5 shrink-0 hover:text-sp-text"
              aria-label="Remove imported schema"
            >
              <X className="h-3 w-3" />
              Remove
            </button>
          )}
        </div>
      )}

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
            {loading
              ? 'Loading schema…'
              : 'No schema loaded. Hit refresh to introspect, or load an SDL / introspection JSON file if introspection is disabled.'}
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
                const fields = getMembers(schema, row.name);
                return fields.some((f) => filterBySearch(f.name));
              })
              .map((row) => {
                const fields = getMembers(schema, row.name);
                const selectable = row.kind !== 'INPUT';
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
                      {row.tag && (
                        <span
                          className="sp-label ml-auto"
                          style={{ fontSize: '8.5px' }}
                          title={row.tag.title}
                        >
                          {row.tag.label}
                        </span>
                      )}
                    </button>

                    {isExpanded && hasFields && (
                      <div className="ml-4 pl-2 border-l border-sp-line flex flex-col gap-0.5 mt-0.5 mb-1">
                        {filteredFields.map((field) =>
                          selectable ? (
                            <button
                              key={field.name}
                              type="button"
                              onClick={() => onFieldSelect?.(field.name)}
                              className="flex items-center justify-between gap-2 w-full text-left px-1.5 h-5 rounded-sp-chip hover:bg-sp-hover transition-colors"
                            >
                              <MemberName member={field} />
                              <span className="font-mono text-sp-11 text-sp-dim truncate">
                                {formatTypeRef(field.type)}
                              </span>
                            </button>
                          ) : (
                            // Input fields can't be selected into a query.
                            <div
                              key={field.name}
                              className="flex items-center justify-between gap-2 w-full px-1.5 h-5"
                            >
                              <MemberName member={field} />
                              <span className="font-mono text-sp-11 text-sp-dim truncate">
                                {formatTypeRef(field.type)}
                              </span>
                            </div>
                          )
                        )}
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
