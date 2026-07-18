import type { SubscriptionMessage } from './subscriptionClient';

export const MAX_SUBSCRIPTION_MESSAGES = 500;

export interface SubscriptionLogMessage extends SubscriptionMessage {
  payloadText?: string;
}

export interface SubscriptionLogState {
  messages: SubscriptionLogMessage[];
  dataCount: number;
}

export const emptySubscriptionLog: SubscriptionLogState = { messages: [], dataCount: 0 };

function serializePayload(payload: unknown): string {
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

export function appendSubscriptionMessage(
  messages: SubscriptionLogMessage[],
  message: SubscriptionMessage
): SubscriptionLogMessage[] {
  const next = {
    ...message,
    ...(message.payload === undefined ? {} : { payloadText: serializePayload(message.payload) }),
  };
  const appended = [...messages, next];
  return appended.length > MAX_SUBSCRIPTION_MESSAGES
    ? appended.slice(-MAX_SUBSCRIPTION_MESSAGES)
    : appended;
}

export function countSubscriptionData(messages: SubscriptionLogMessage[]): number {
  let count = 0;
  for (const message of messages) {
    if (message.type === 'data') count++;
  }
  return count;
}

export function appendSubscriptionLog(
  state: SubscriptionLogState,
  message: SubscriptionMessage
): SubscriptionLogState {
  const dropped =
    state.messages.length === MAX_SUBSCRIPTION_MESSAGES ? state.messages[0] : undefined;
  return {
    messages: appendSubscriptionMessage(state.messages, message),
    dataCount:
      state.dataCount + (message.type === 'data' ? 1 : 0) - (dropped?.type === 'data' ? 1 : 0),
  };
}
