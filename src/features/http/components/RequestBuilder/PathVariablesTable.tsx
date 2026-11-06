import { syncPathVariableRows } from '@shared/protocol/path-variables';
import { useMemo } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { toParamRow } from '@/components/shared/ParamHeaderTable';
import { PARAM_GRID, ParamRow, type VariableStatus } from '@/components/ui/spatial';
import type { KeyValue } from '@/types';

interface PathVariablesTableProps {
  /** From {@link usePathVariableRows}. */
  rows: KeyValue[];
  onChange: (rows: KeyValue[]) => void;
  getStatus?: (varName: string) => VariableStatus;
}

const COLUMN_LABELS = ['KEY', 'VALUE', 'DESCRIPTION'] as const;

/**
 * The rows to show: the stored rows synced to the URL's `:name` segments, so a
 * request saved before path variables existed still shows them (the first
 * edit stores the full list).
 */
export function usePathVariableRows(
  url: string,
  pathVariables: readonly KeyValue[] | undefined
): KeyValue[] {
  return useMemo(() => syncPathVariableRows(url, pathVariables, uuidv4), [url, pathVariables]);
}

/**
 * Postman-style "Path variables": one row per `:name` segment of the URL's
 * path. Keys come from the URL (read-only, no add/remove — edit the URL);
 * value, description and the enabled toggle are editable. Values may hold
 * `{{vars}}`; the send path resolves and percent-encodes them.
 */
export function PathVariablesTable({ rows, onChange, getStatus }: PathVariablesTableProps) {
  if (rows.length === 0) return null;

  return (
    <section aria-label="Path variables" className="flex flex-col border-t border-sp-line">
      <h3 className="sp-label text-sp-11 px-3 pt-3 pb-1.5 text-sp-dim">Path variables</h3>
      <div
        className="grid items-center border-y border-sp-line bg-sp-surface-lo/30"
        style={{ gridTemplateColumns: PARAM_GRID }}
      >
        <span aria-hidden="true" />
        {COLUMN_LABELS.map((col) => (
          <span key={col} className="sp-label text-sp-11 px-2 py-2 border-l border-sp-line/40">
            {col}
          </span>
        ))}
        <span aria-hidden="true" />
      </div>
      <div>
        {rows.map((row) => (
          <ParamRow
            key={row.id}
            row={toParamRow(row)}
            keyReadOnly
            itemLabel="path variable"
            showVariableHighlight
            {...(getStatus && { getStatus })}
            onChange={(next) =>
              onChange(
                rows.map((r) =>
                  r.id === next.id
                    ? {
                        ...r,
                        enabled: next.enabled,
                        value: next.value,
                        ...(next.description !== undefined && { description: next.description }),
                      }
                    : r
                )
              )
            }
          />
        ))}
      </div>
    </section>
  );
}
