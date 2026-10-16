/**
 * Interactive-Send glue for `@defer` / `@stream` (#885): turn the protocol's
 * live snapshots into provisional responses (and published part errors), and
 * finalise the last one if the run stops early. Kept out of the builder so it
 * stays thin and the behaviour is unit-testable.
 */
import { type GraphQLErrorEntry, parseGraphQLErrors } from '@/features/graphql/lib/graphqlErrors';
import {
  type IncrementalSnapshot,
  snapshotToResponse,
  stoppedSnapshotResponse,
} from '@/features/graphql/lib/graphqlHttp';
import type { StreamRunHooks } from '@/features/registry/types';
import type { Response as ApiResponse } from '@/types';

export interface IncrementalSendOptions {
  /** Only `@defer` / `@stream` operations get live hooks. */
  enabled: boolean;
  requestId: string;
  startedAt: number;
  /** Show a (provisional or finalised) response on the originating tab. */
  setResponse: (response: ApiResponse) => void;
  /** Publish a snapshot's errors to the editor markers. */
  publishErrors: (errors: GraphQLErrorEntry[]) => void;
}

export interface IncrementalSend {
  /** Pass as `RegistryRunOptions.stream`; undefined when not enabled. */
  stream: StreamRunHooks | undefined;
  /** The run threw: replace a stale "more on the way" snapshot. */
  stop(aborted: boolean): void;
}

export function createIncrementalSend(options: IncrementalSendOptions): IncrementalSend {
  let last: ApiResponse | undefined;
  return {
    stream: options.enabled
      ? {
          onMessage: (message: unknown) => {
            const snapshot = message as IncrementalSnapshot;
            last = snapshotToResponse(snapshot, options.requestId, options.startedAt);
            options.setResponse(last);
            // Part errors (incremental `errors`, `completed[].errors`) reach
            // the editor markers as they arrive, not only at the end.
            options.publishErrors(parseGraphQLErrors(snapshot.result));
          },
        }
      : undefined,
    stop(aborted) {
      if (last) {
        options.setResponse(stoppedSnapshotResponse(last, aborted ? 'cancelled' : 'failed'));
      }
    },
  };
}
