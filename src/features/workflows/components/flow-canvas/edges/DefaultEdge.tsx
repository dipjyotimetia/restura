/**
 * Phase 2's only edge component: smooth bezier with the glass theme's
 * border colour. Phase 4 will add an animated variant for active edges.
 */
import { memo } from 'react';
import { BaseEdge, getSmoothStepPath, type EdgeProps } from '@xyflow/react';

function DefaultEdgeImpl({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  style,
}: EdgeProps) {
  const [edgePath] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 8,
  });
  return (
    <BaseEdge
      id={id}
      path={edgePath}
      markerEnd={markerEnd}
      style={{
        strokeWidth: 1.5,
        stroke: 'hsl(var(--foreground) / var(--border-strong))',
        ...style,
      }}
    />
  );
}

export const DefaultEdge = memo(DefaultEdgeImpl);
DefaultEdge.displayName = 'DefaultEdge';
