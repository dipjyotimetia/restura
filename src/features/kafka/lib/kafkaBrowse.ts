import {
  KAFKA_DEFAULT_BROWSE_LAST_N,
  type KafkaConsumerState,
} from '@/features/kafka/store/useKafkaStore';
import type { ElectronKafkaAPI } from '../../../../electron/types/electron-api';

export type KafkaSubscribePayload = Parameters<ElectronKafkaAPI['subscribe']>[0];

/** Settings that only exist for a group member; browse never sends them. */
const GROUP_ONLY_KEYS = [
  'groupId',
  'fallbackMode',
  'commitPolicy',
  'autoCommitIntervalMs',
  'groupProtocol',
  'groupInstanceId',
  'groupRemoteAssignor',
  'sessionTimeoutMs',
  'rebalanceTimeoutMs',
  'heartbeatIntervalMs',
  'lagIntervalMs',
] as const satisfies ReadonlyArray<keyof KafkaSubscribePayload>;

export function isKafkaBrowse(consumer: Pick<KafkaConsumerState, 'membership'> | undefined) {
  return consumer?.membership === 'browse';
}

/**
 * Turns the group-mode subscribe payload into the browse (no group, no commit)
 * one: strips every group-only setting and adds the browse start/stop limits.
 * The main process refuses group-only fields in browse mode, so this is the
 * single place the renderer decides what a browse subscribe carries.
 */
export function toBrowseSubscribe(
  payload: KafkaSubscribePayload,
  consumer: Pick<KafkaConsumerState, 'lastN' | 'maxMessages'>
): KafkaSubscribePayload {
  const browse: KafkaSubscribePayload = { ...payload, membership: 'browse' };
  for (const key of GROUP_ONLY_KEYS) delete browse[key];
  if (browse.mode === 'committed') browse.mode = 'last-n';
  if (browse.mode === 'last-n') browse.lastN = consumer.lastN ?? KAFKA_DEFAULT_BROWSE_LAST_N;
  if (consumer.maxMessages) browse.maxMessages = consumer.maxMessages;
  return browse;
}
