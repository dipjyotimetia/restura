import { describe, expect, it } from 'vitest';
import { KafkaSubscribeSchema } from '../ipc/ipc-validators';

// Browse mode (#930/#980): a group-less, commit-less read. The schema is the
// IPC boundary, so it — not just the renderer — must refuse any combination that
// would need a consumer group.
const browse = (extra: Record<string, unknown> = {}) => ({
  connectionId: 'c',
  membership: 'browse',
  topics: ['orders'],
  mode: 'earliest',
  ...extra,
});

function issuePaths(input: unknown): string[] {
  const result = KafkaSubscribeSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
}

describe('KafkaSubscribeSchema — membership', () => {
  it('defaults to group membership so an omitted field keeps the pre-browse contract', () => {
    const parsed = KafkaSubscribeSchema.parse({
      connectionId: 'c',
      groupId: 'g',
      topics: ['orders'],
    });
    expect(parsed.membership).toBe('group');
  });

  it('requires a groupId in group mode', () => {
    expect(issuePaths({ connectionId: 'c', topics: ['orders'], mode: 'latest' })).toContain(
      'groupId'
    );
    expect(
      issuePaths({ connectionId: 'c', membership: 'group', topics: ['orders'], mode: 'latest' })
    ).toContain('groupId');
  });

  it('accepts browse mode without a groupId for every start position', () => {
    expect(KafkaSubscribeSchema.safeParse(browse()).success).toBe(true);
    expect(KafkaSubscribeSchema.safeParse(browse({ mode: 'latest' })).success).toBe(true);
    expect(
      KafkaSubscribeSchema.safeParse(browse({ mode: 'timestamp', timestamp: '1718800000000' }))
        .success
    ).toBe(true);
    expect(
      KafkaSubscribeSchema.safeParse(
        browse({ mode: 'manual', offsets: [{ topic: 'orders', partition: 0, offset: '5' }] })
      ).success
    ).toBe(true);
    expect(KafkaSubscribeSchema.safeParse(browse({ mode: 'last-n', lastN: 10 })).success).toBe(
      true
    );
  });

  it('accepts an optional stop-after-N limit in browse mode', () => {
    const parsed = KafkaSubscribeSchema.parse(browse({ maxMessages: 25 }));
    expect(parsed.maxMessages).toBe(25);
    expect(issuePaths(browse({ maxMessages: 0 }))).toContain('maxMessages');
    expect(issuePaths(browse({ maxMessages: 1.5 }))).toContain('maxMessages');
  });

  it('rejects anything in browse mode that needs a consumer group', () => {
    expect(issuePaths(browse({ groupId: 'restura-abc' }))).toContain('groupId');
    expect(issuePaths(browse({ mode: 'committed' }))).toContain('mode');
    expect(issuePaths(browse({ commitPolicy: 'manual' }))).toContain('commitPolicy');
    expect(issuePaths(browse({ groupProtocol: 'consumer' }))).toContain('groupProtocol');
    expect(issuePaths(browse({ groupInstanceId: 'static-1' }))).toContain('groupInstanceId');
    expect(issuePaths(browse({ groupRemoteAssignor: 'uniform' }))).toContain('groupRemoteAssignor');
  });

  it('does not default the start position to committed in browse mode', () => {
    // `committed` is the group-mode default; browse has no committed offsets.
    expect(issuePaths({ connectionId: 'c', membership: 'browse', topics: ['orders'] })).toContain(
      'mode'
    );
  });

  it('requires a positive bounded lastN for last-n, which is browse-only', () => {
    expect(issuePaths(browse({ mode: 'last-n' }))).toContain('lastN');
    expect(issuePaths(browse({ mode: 'last-n', lastN: 0 }))).toContain('lastN');
    expect(issuePaths(browse({ mode: 'last-n', lastN: 1_000_001 }))).toContain('lastN');
    expect(
      issuePaths({
        connectionId: 'c',
        groupId: 'g',
        topics: ['orders'],
        mode: 'last-n',
        lastN: 10,
      })
    ).toContain('mode');
  });

  it('keeps maxMessages browse-only so group mode stays unchanged', () => {
    expect(
      issuePaths({
        connectionId: 'c',
        groupId: 'g',
        topics: ['orders'],
        mode: 'latest',
        maxMessages: 5,
      })
    ).toContain('maxMessages');
  });

  it('rejects an unknown membership', () => {
    expect(issuePaths(browse({ membership: 'assign' }))).toContain('membership');
  });

  it('rejects group-only tuning in browse mode but keeps the legacy fromBeginning flag', () => {
    for (const [field, value] of [
      ['autoCommitIntervalMs', 500],
      ['sessionTimeoutMs', 10_000],
      ['rebalanceTimeoutMs', 10_000],
      ['heartbeatIntervalMs', 3_000],
      ['lagIntervalMs', 1_000],
      ['fallbackMode', 'earliest'],
    ] as const) {
      expect(issuePaths(browse({ [field]: value }))).toContain(field);
    }
    expect(KafkaSubscribeSchema.safeParse(browse({ fromBeginning: true })).success).toBe(true);
  });

  it('caps browse offsets and timestamps at the signed 64-bit maximum', () => {
    const max = '9223372036854775807';
    const over = '9223372036854775808';
    const offset = (value: string) =>
      browse({ mode: 'manual', offsets: [{ topic: 'orders', partition: 0, offset: value }] });
    expect(KafkaSubscribeSchema.safeParse(offset(max)).success).toBe(true);
    expect(issuePaths(offset(over))).toContain('offsets.0.offset');
    expect(
      KafkaSubscribeSchema.safeParse(browse({ mode: 'timestamp', timestamp: max })).success
    ).toBe(true);
    expect(issuePaths(browse({ mode: 'timestamp', timestamp: over }))).toContain('timestamp');
  });
});
