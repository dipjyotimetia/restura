// Small presentational helpers shared by KafkaClient and the admin inspector
// sub-components (KafkaTopicInspector / KafkaGroupInspector) so per-partition
// coloring and the accent stay consistent across the feature.

export const KAFKA_PINK = '#f472b6';

// Rotated palette for per-partition pills + PART columns.
export const PARTITION_COLORS = [
  '#22c55e', // P0
  '#3b82f6', // P1
  '#a855f7', // P2
  '#f59e0b', // P3
  '#06b6d4', // P4
  '#ef4444', // P5
] as const;

export function partitionColor(p: number | undefined): string {
  if (p === undefined || p < 0) return '#94a3b8';
  return PARTITION_COLORS[p % PARTITION_COLORS.length] ?? '#94a3b8';
}
