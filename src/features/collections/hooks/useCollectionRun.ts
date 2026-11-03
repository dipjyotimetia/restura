import type { ResponseRetentionMode } from '@shared/collection-run/evidence';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useCollectionRunStore } from '@/store/useCollectionRunStore';
import {
  type ConsoleLog,
  type ConsoleProtocol,
  type ConsoleTest,
  useConsoleStore,
} from '@/store/useConsoleStore';
import type { Collection } from '@/types';
import {
  type CollectionRunResult,
  type RequestCompleteInfo,
  type RunProgress,
  runCollection,
} from '../lib/collectionRunner';
import type { IterationRow } from '../lib/dataLoader';
import type { RunnableRequest } from '../lib/flattenRunnables';
import { resolveRunVariables } from '../lib/runVariables';

export interface StartRunArgs {
  collection: Collection;
  scopeName: string;
  runnables: RunnableRequest[];
  /** Environment id ('none' or unknown ⇒ no environment vars). */
  environmentId: string;
  iterations: number;
  dataRows: IterationRow[];
  delayMs: number;
  stopOnFailure: boolean;
  retention: ResponseRetentionMode;
}

// Run-variable resolution lives in lib/ (pure store reads); re-exported here
// for existing callers.
export { buildBaseVars, type RunVariables } from '../lib/runVariables';

/** Mirror a finished runner request into the Console, tagged by run. */
function pushConsoleEntry(info: RequestCompleteInfo): void {
  if (!info.response) return; // skipped / never-ran requests don't get a network entry
  const req = info.request;
  const headers: Record<string, string> = {};
  if ('headers' in req && Array.isArray(req.headers)) {
    for (const h of req.headers) if (h.enabled && h.key) headers[h.key] = h.value;
  }
  const body = req.type === 'http' && req.body.type !== 'none' ? req.body.raw : undefined;

  const logs: ConsoleLog[] = [
    ...(info.scripts?.preRequest?.logs ?? []),
    ...(info.scripts?.test?.logs ?? []),
  ];
  const tests: ConsoleTest[] = info.result.assertions.map((a) => ({
    name: a.name,
    passed: a.passed,
    ...(a.error ? { error: a.error } : {}),
  }));

  useConsoleStore.getState().addEntry({
    timestamp: Date.now(),
    protocol: req.type as ConsoleProtocol,
    request: {
      method: req.type === 'http' ? req.method : req.type.toUpperCase(),
      url: 'url' in req ? req.url : '',
      headers,
      ...(body !== undefined && { body }),
    },
    response: info.response,
    ...(logs.length > 0 && { scriptLogs: logs }),
    ...(tests.length > 0 && { tests }),
    runId: info.runId,
    runLabel: info.scopeName,
    iteration: info.result.iteration,
  });
}

/**
 * Drives a collection / folder run: assembles base variables, runs the loop,
 * throttles progress to the UI, mirrors each request into the Console, and on
 * completion persists the result to `useCollectionRunStore` (so it survives the
 * dialog closing and shows up in the Runs panel).
 */
export function useCollectionRun() {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<RunProgress | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastEmit = useRef(0);
  const mountedRef = useRef(false);
  const runGenerationRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      runGenerationRef.current += 1;
      const controller = abortRef.current;
      abortRef.current = null;
      controller?.abort();
    };
  }, []);

  const start = useCallback((args: StartRunArgs) => {
    if (!mountedRef.current || abortRef.current) return;
    setProgress(null);
    setRunning(true);
    lastEmit.current = 0;
    const ac = new AbortController();
    abortRef.current = ac;
    const runGeneration = ++runGenerationRef.current;
    const isCurrent = () => mountedRef.current && runGeneration === runGenerationRef.current;

    const { selectedEnvironment, globalVars, baseVars, environmentVars, secretNames } =
      resolveRunVariables(args.environmentId, args.collection);

    void runCollection(
      {
        collection: args.collection,
        scopeName: args.scopeName,
        runnables: args.runnables,
        baseVars,
        globalVars,
        environmentVars,
        secretNames,
        iterations: args.iterations,
        dataRows: args.dataRows,
        delayMs: args.delayMs,
        stopOnFailure: args.stopOnFailure,
        retention: args.retention,
        ...(args.environmentId !== 'none' ? { environmentId: args.environmentId } : {}),
        ...(selectedEnvironment ? { environmentName: selectedEnvironment.name } : {}),
      },
      (p) => {
        if (!isCurrent()) return;
        const now = performance.now();
        if (p.done || now - lastEmit.current > 100) {
          lastEmit.current = now;
          setProgress(p);
        }
      },
      ac.signal,
      (info) => {
        if (isCurrent()) pushConsoleEntry(info);
      }
    )
      .then((result: CollectionRunResult) => {
        if (isCurrent()) useCollectionRunStore.getState().addRun(result);
      })
      .catch((error: unknown) => {
        if (isCurrent()) {
          toast.error('Collection run failed', {
            description: error instanceof Error ? error.message : String(error),
          });
        }
      })
      .finally(() => {
        if (abortRef.current === ac) abortRef.current = null;
        if (isCurrent()) setRunning(false);
      });
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { running, progress, start, stop };
}
