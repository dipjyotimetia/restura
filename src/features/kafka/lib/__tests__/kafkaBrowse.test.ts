import { describe, expect, it } from 'vitest';
import { isKafkaBrowse, toBrowseSubscribe } from '@/features/kafka/lib/kafkaBrowse';

const groupPayload = {
  connectionId: 'c',
  groupId: 'restura-abc',
  topics: ['orders'],
  mode: 'earliest' as const,
  fallbackMode: 'latest' as const,
  commitPolicy: 'manual' as const,
  autoCommitIntervalMs: 500,
  isolation: 'read-committed' as const,
  groupProtocol: 'consumer' as const,
  groupInstanceId: 'static',
  groupRemoteAssignor: 'uniform',
  sessionTimeoutMs: 1,
  rebalanceTimeoutMs: 2,
  heartbeatIntervalMs: 3,
  lagIntervalMs: 1000,
  maxBytes: 2048,
  highWaterMark: 16,
};

describe('toBrowseSubscribe', () => {
  it('strips every group-only setting and keeps fetch tuning and isolation', () => {
    expect(toBrowseSubscribe(groupPayload, {})).toEqual({
      connectionId: 'c',
      membership: 'browse',
      topics: ['orders'],
      mode: 'earliest',
      isolation: 'read-committed',
      maxBytes: 2048,
      highWaterMark: 16,
    });
  });

  it('adds last-N and the stop-after limit, replacing a committed start', () => {
    expect(
      toBrowseSubscribe({ ...groupPayload, mode: 'committed' }, { lastN: 10, maxMessages: 5 })
    ).toMatchObject({ mode: 'last-n', lastN: 10, maxMessages: 5 });
    expect(toBrowseSubscribe({ ...groupPayload, mode: 'last-n' }, {})).toMatchObject({
      lastN: 50,
    });
    expect(toBrowseSubscribe(groupPayload, { lastN: 10 })).not.toHaveProperty('lastN');
  });
});

describe('isKafkaBrowse', () => {
  it('treats a missing membership as group mode', () => {
    expect(isKafkaBrowse({ membership: 'browse' })).toBe(true);
    expect(isKafkaBrowse({ membership: 'group' })).toBe(false);
    expect(isKafkaBrowse({})).toBe(false);
    expect(isKafkaBrowse(undefined)).toBe(false);
  });
});
