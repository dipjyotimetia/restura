import { ipcMain } from 'electron';
import { IPC } from '../../../shared/channels';
import { createValidatedEventHandler, KafkaConsumerControlSchema } from '../../ipc/ipc-validators';
import type { ConsumerFlowControl } from './consumer-flow';

/** The slice of a live Kafka connection the consumer controls need. */
export interface KafkaConsumerControlEntry {
  connectionId: string;
  flow?: ConsumerFlowControl;
}

interface ConsumerControlDependencies<E extends KafkaConsumerControlEntry> {
  getEntry: (connectionId: string, ownerId: number) => E | undefined;
  /** Publish a `kafka:consumer-status:<id>` lifecycle event to the owning renderer. */
  emitStatus: (entry: E, payload: Record<string, unknown>) => void;
}

/**
 * Whole-stream pause/resume. These flip only the *user* pause reason; the
 * stream stays paused while backpressure still holds it (see consumer-flow.ts).
 */
export function registerKafkaConsumerControlHandlers<E extends KafkaConsumerControlEntry>(
  deps: ConsumerControlDependencies<E>
): void {
  const setUserPaused = (channel: string, paused: boolean): void => {
    ipcMain.handle(
      channel,
      createValidatedEventHandler(channel, KafkaConsumerControlSchema, async (cfg, event) => {
        const entry = deps.getEntry(cfg.connectionId, event.sender.id);
        if (!entry?.flow) return { success: false, error: 'No consumer is active.' };
        entry.flow.setUserPaused(paused);
        deps.emitStatus(entry, { state: paused ? 'paused' : 'resumed' });
        return { success: true };
      })
    );
  };
  setUserPaused(IPC.kafka.pauseConsumer, true);
  setUserPaused(IPC.kafka.resumeConsumer, false);
}
