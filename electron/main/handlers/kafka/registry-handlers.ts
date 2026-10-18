import { ipcMain } from 'electron';
import type { ZodSchema } from 'zod';
import { IPC } from '../../../shared/channels';
import { type KeyedRateLimiter, rateLimited } from '../../ipc/ipc-rate-limiter';
import { errorMessage } from '../../ipc/ipc-utils';
import {
  createValidatedEventHandler,
  KafkaRegistryGetSchemaSchema,
  KafkaRegistryListSubjectsSchema,
  KafkaRegistryListVersionsSchema,
} from '../../ipc/ipc-validators';
import type { KafkaRegistryClient } from './registry';

export interface KafkaRegistryEntry {
  registry?: KafkaRegistryClient;
}

interface RegistryDependencies {
  getEntry: (connectionId: string, ownerId: number) => KafkaRegistryEntry | undefined;
  rateLimiter: KeyedRateLimiter;
}

/**
 * Read-only Schema Registry browsing for the subject picker / schema viewer.
 * Each call is rate-limited, sender-checked and Zod-validated, and reuses the
 * owning connection's registry client (TLS policy + SSRF-guarded agent).
 */
export function registerKafkaRegistryHandlers(deps: RegistryDependencies): void {
  const handle = <TInput extends { connectionId: string }, T extends object>(
    channel: string,
    schema: ZodSchema<TInput>,
    fn: (registry: KafkaRegistryClient, input: TInput) => Promise<T>
  ): void => {
    ipcMain.handle(
      channel,
      rateLimited(
        deps.rateLimiter,
        createValidatedEventHandler(
          channel,
          schema,
          async (
            input: TInput,
            event
          ): Promise<({ success: true } & T) | { success: false; error: string }> => {
            const entry = deps.getEntry(input.connectionId, event.sender.id);
            if (!entry) return { success: false, error: 'Not connected' };
            if (!entry.registry) {
              return {
                success: false,
                error: 'No Schema Registry is configured on this connection.',
              };
            }
            try {
              return { success: true, ...(await fn(entry.registry, input)) };
            } catch (err) {
              return { success: false, error: errorMessage(err) };
            }
          }
        )
      )
    );
  };

  handle(IPC.kafka.registryListSubjects, KafkaRegistryListSubjectsSchema, async (registry) => ({
    subjects: await registry.listSubjects(),
  }));
  handle(
    IPC.kafka.registryListVersions,
    KafkaRegistryListVersionsSchema,
    async (registry, cfg) => ({
      versions: await registry.listVersions(cfg.subject),
    })
  );
  handle(IPC.kafka.registryGetSchema, KafkaRegistryGetSchemaSchema, async (registry, cfg) => ({
    schema: await registry.getSchema(cfg.subject, cfg.version),
  }));
}
