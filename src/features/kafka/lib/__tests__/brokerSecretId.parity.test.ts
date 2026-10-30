import {
  kafkaBoundSecretHandleId,
  brokerSecretHandleId as mainSideHandleId,
} from '@shared/protocol/broker-secret-id';
import { describe, expect, it } from 'vitest';
import { kafkaSecretKey } from '@/features/kafka/lib/kafkaManager';
import { brokerSecretHandleId, brokerSecretRef } from '@/lib/shared/broker-secrets';

// Main binds a stored Kafka credential handle to its connection + field by
// recomputing the renderer's deterministic id (SEC-K3). If the two ever drift,
// every stored credential reads as "missing — re-enter it".
describe('broker secret handle id parity (renderer ↔ main)', () => {
  it('derives identical ids on both sides', () => {
    for (const key of ['kafka:c1:sasl-password', 'kafka:preset-r1:registry-token', 'mqtt:x:pw']) {
      expect(mainSideHandleId(key)).toBe(brokerSecretHandleId(key));
    }
  });

  it('binds the handle the manager sends to the connection and field', () => {
    expect(brokerSecretRef(kafkaSecretKey('conn-9', 'tls-passphrase'))).toEqual({
      kind: 'handle',
      id: kafkaBoundSecretHandleId('conn-9', 'tls-passphrase'),
    });
  });
});
