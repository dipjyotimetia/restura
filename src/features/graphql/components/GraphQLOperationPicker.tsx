'use client';

import { PenLine, Radio, Search } from 'lucide-react';
import {
  type GraphQLOperationInfo,
  type GraphQLOperationType,
  isSameOperation,
  operationChipLabel,
} from '@/features/graphql/lib/operationSelection';
import { cn } from '@/lib/shared/utils';

const TYPE_ICON: Record<GraphQLOperationType, typeof Search> = {
  query: Search,
  mutation: PenLine,
  subscription: Radio,
};

interface GraphQLOperationPickerProps {
  operations: GraphQLOperationInfo[];
  selected: GraphQLOperationInfo | undefined;
  onSelect: (operation: GraphQLOperationInfo) => void;
}

/**
 * Operation chips above the query editor (#903). Only rendered for documents
 * with more than one operation — a single operation has nothing to pick. The
 * type icon shows which transport the chip will run on (subscription = WS).
 */
export function GraphQLOperationPicker({
  operations,
  selected,
  onSelect,
}: GraphQLOperationPickerProps) {
  if (operations.length < 2) return null;
  return (
    <div
      role="group"
      aria-label="GraphQL operations"
      className="flex items-center gap-1 px-3 pt-2 overflow-x-auto shrink-0"
    >
      {operations.map((op, i) => {
        const Icon = TYPE_ICON[op.type];
        const active = isSameOperation(op, selected);
        const label = operationChipLabel(op);
        return (
          <button
            key={`${i}-${label}`}
            type="button"
            aria-pressed={active}
            aria-label={`${label} (${op.type})`}
            title={`${op.type}${op.type === 'subscription' ? ' · WebSocket' : ' · HTTP POST'}`}
            onClick={() => onSelect(op)}
            className={cn(
              'inline-flex items-center gap-1 h-6 px-2 rounded-sp-chip text-sp-11 font-mono shrink-0 border transition-colors',
              active
                ? 'bg-sp-active text-sp-text border-sp-line'
                : 'border-transparent text-sp-muted hover:text-sp-text hover:bg-sp-hover'
            )}
          >
            <Icon className="h-3 w-3" aria-hidden="true" />
            {label}
          </button>
        );
      })}
    </div>
  );
}
