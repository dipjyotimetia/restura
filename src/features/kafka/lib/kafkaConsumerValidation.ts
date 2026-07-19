const MAX_KAFKA_PARTITION = 2_147_483_647;

export function isValidManualOffset(partition: string, offset: string): boolean {
  const normalizedPartition = partition.trim();
  const normalizedOffset = offset.trim();
  return (
    /^\d+$/.test(normalizedPartition) &&
    Number(normalizedPartition) <= MAX_KAFKA_PARTITION &&
    /^\d+$/.test(normalizedOffset)
  );
}
