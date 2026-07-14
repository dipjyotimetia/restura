/**
 * Drill-down breadcrumb for nested forEach / tryCatch subgraph editing.
 *
 * Each segment renders as a chip showing the parent node's kind + label
 * (e.g. "forEach: items"). Clicking any chip pops the path back to that
 * level. The first chip is always "root", which clears the path.
 *
 * Renders nothing when path is empty (no nesting).
 */
'use client';

import { ChevronRight, GitBranch } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { FlowNode, SubgraphPath, Workflow } from '@/types';
import { pathSegmentLabel, selectAtPath } from '../../lib/flowTypes';

interface FlowBreadcrumbProps {
  workflow: Workflow;
  path: SubgraphPath;
  onNavigate: (nextPath: SubgraphPath) => void;
}

function describeParentNode(node: FlowNode | undefined): string {
  if (!node) return '?';
  if (node.kind === 'forEach') {
    // Short preview of the iterator variable so the user can tell two
    // sibling forEach drilldowns apart.
    return `forEach: ${node.data.iteratorVar || '…'}`;
  }
  if (node.kind === 'tryCatch') return 'tryCatch';
  return node.kind;
}

export function FlowBreadcrumb({ workflow, path, onNavigate }: FlowBreadcrumbProps) {
  if (path.length === 0) return null;

  // Resolve each segment's parent node by walking the path prefix.
  // We need both the parent kind (for the chip label) and to know that
  // the prefix actually still resolves — a stale path (e.g. parent
  // node was deleted in a different tab) shouldn't crash.
  const segments: Array<{ parentLabel: string; key: SubgraphPath[number]['key'] }> = [];
  let rootGraph = workflow.graph;
  for (let i = 0; i < path.length; i++) {
    if (!rootGraph) break;
    const segment = path[i];
    if (!segment) break;
    const parent = rootGraph.nodes.find((n) => n.id === segment.parentNodeId);
    segments.push({
      parentLabel: describeParentNode(parent),
      key: segment.key,
    });
    // Step one level deeper for the next iteration.
    const next = selectAtPath(rootGraph, [segment]);
    rootGraph = next ?? undefined;
  }

  return (
    <div className="flex items-center gap-1 px-2 py-1.5 border-b border-sp-line bg-sp-surface overflow-x-auto">
      <GitBranch className="h-3 w-3 text-muted-foreground flex-shrink-0" />
      <Button
        variant="ghost"
        size="sm"
        className="h-6 px-2 text-xs font-mono"
        onClick={() => onNavigate([])}
      >
        root
      </Button>
      {segments.map((seg, i) => (
        <span key={i} className="flex items-center gap-1 flex-shrink-0">
          <ChevronRight className="h-3 w-3 text-sp-dim" />
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs font-mono"
            onClick={() => onNavigate(path.slice(0, i + 1))}
            // Last chip is the current location — render as plain text
            // (still keyboard-focusable for symmetry).
            disabled={i === segments.length - 1}
            title={`${seg.parentLabel} / ${pathSegmentLabel(seg.key)}`}
          >
            <span className="text-sp-muted">{seg.parentLabel}</span>
            <span className="text-sp-dim mx-1">/</span>
            <span>{pathSegmentLabel(seg.key)}</span>
          </Button>
        </span>
      ))}
    </div>
  );
}
