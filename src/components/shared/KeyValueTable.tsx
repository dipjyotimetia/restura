import { v4 as uuidv4 } from 'uuid';
import {
  HEADER_KEY_SUGGESTIONS,
  headerValueSuggestionsFor,
  ParamHeaderTable,
  toParamRow,
} from '@/components/shared/ParamHeaderTable';
import type { ParamRowData } from '@/components/ui/spatial';
import { useVariableStatus, type VariableScope } from '@/hooks/useVariableStatus';
import type { KeyValue } from '@/types';

interface KeyValueTableProps {
  items: KeyValue[];
  /** Receives the whole next list — every edit, add, remove and bulk edit. */
  onChange: (items: KeyValue[]) => void;
  /** Singular noun for accessible names, e.g. 'header' or 'metadata'. */
  itemLabel: string;
  /** Footer add-button text, e.g. 'Add header'. */
  addLabel: string;
  /**
   * The send path substitutes `{{var}}` in these values with this resolver.
   * Omit when values are sent literally — no highlight is shown then.
   */
  resolvesVariables?: VariableScope;
  /** Offer standard HTTP header names/values (real HTTP headers only). */
  httpHeaders?: boolean;
}

/**
 * The request builder's key/value table for protocol config sections (headers,
 * metadata, auth/query fields), driven by a single list setter.
 */
export function KeyValueTable({
  items,
  onChange,
  itemLabel,
  addLabel,
  resolvesVariables,
  httpHeaders = false,
}: KeyValueTableProps) {
  const scope = resolvesVariables ?? 'connection';
  const getStatus = useVariableStatus(scope);

  const updateRow = (row: ParamRowData) =>
    onChange(
      items.map((item) => {
        if (item.id !== row.id) return item;
        const next: KeyValue = { ...item, enabled: row.enabled, key: row.key, value: row.value };
        if (row.description !== undefined) next.description = row.description;
        return next;
      })
    );

  const addRow = (overrides?: Partial<Pick<ParamRowData, 'key' | 'value' | 'description'>>) => {
    const row: KeyValue = {
      id: uuidv4(),
      key: overrides?.key ?? '',
      value: overrides?.value ?? '',
      enabled: true,
    };
    if (overrides?.description) row.description = overrides.description;
    onChange([...items, row]);
  };

  return (
    <ParamHeaderTable
      rows={items.map(toParamRow)}
      onRowChange={updateRow}
      onRowRemove={(id) => onChange(items.filter((item) => item.id !== id))}
      onAdd={addRow}
      source={items}
      onReplaceAll={onChange}
      itemLabel={itemLabel}
      addLabel={addLabel}
      layout="auto"
      showVariableHighlight={resolvesVariables !== undefined}
      variableScope={scope}
      getStatus={getStatus}
      {...(httpHeaders && {
        keySuggestions: HEADER_KEY_SUGGESTIONS,
        valueSuggestionsFor: headerValueSuggestionsFor,
      })}
    />
  );
}
