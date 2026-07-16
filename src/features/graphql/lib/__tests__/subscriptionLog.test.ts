import { describe, expect, it } from 'vitest';
import type { SubscriptionMessage } from '../subscriptionClient';
import {
  appendSubscriptionLog,
  appendSubscriptionMessage,
  countSubscriptionData,
  emptySubscriptionLog,
  MAX_SUBSCRIPTION_MESSAGES,
} from '../subscriptionLog';

const message = (id: number, type: SubscriptionMessage['type'] = 'data'): SubscriptionMessage => ({
  id: String(id),
  type,
  payload: { id },
  timestamp: id,
});

describe('subscriptionLog', () => {
  it('keeps only the newest bounded subscription messages', () => {
    let log: ReturnType<typeof appendSubscriptionMessage> = [];
    for (let i = 0; i <= MAX_SUBSCRIPTION_MESSAGES; i++)
      log = appendSubscriptionMessage(log, message(i));

    expect(log).toHaveLength(MAX_SUBSCRIPTION_MESSAGES);
    expect(log[0]?.id).toBe('1');
    expect(log.at(-1)?.id).toBe(String(MAX_SUBSCRIPTION_MESSAGES));
  });

  it('serializes payloads once and counts data messages without rescanning during render', () => {
    const log = [
      appendSubscriptionMessage([], message(1))[0]!,
      appendSubscriptionMessage([], message(2, 'connected'))[0]!,
    ];

    expect(log[0]?.payloadText).toBe('{\n  "id": 1\n}');
    expect(countSubscriptionData(log)).toBe(1);
  });

  it('keeps the data count correct when the bounded log evicts a message', () => {
    let log = emptySubscriptionLog;
    for (let i = 0; i < MAX_SUBSCRIPTION_MESSAGES; i++) {
      log = appendSubscriptionLog(log, message(i));
    }
    log = appendSubscriptionLog(log, message(MAX_SUBSCRIPTION_MESSAGES, 'connected'));

    expect(log.dataCount).toBe(MAX_SUBSCRIPTION_MESSAGES - 1);
  });
});
