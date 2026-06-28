// Small presentational helpers shared by KafkaClient and the admin inspector
// sub-components (KafkaTopicInspector / KafkaGroupInspector) so per-partition
// coloring and the accent stay consistent across the feature.

export const KAFKA_PINK = 'var(--color-proto-kafka)';

// Rotated palette for per-partition pills + PART columns.
export const PARTITION_COLORS = [
  'var(--color-success)', // P0
  'var(--color-method-put)', // P1
  'var(--color-method-patch)', // P2
  'var(--color-warning)', // P3
  'var(--color-info)', // P4
  'var(--color-danger)', // P5
] as const;

export function partitionColor(p: number | undefined): string {
  if (p === undefined || p < 0) return 'var(--color-neutral)';
  return PARTITION_COLORS[p % PARTITION_COLORS.length] ?? 'var(--color-neutral)';
}
