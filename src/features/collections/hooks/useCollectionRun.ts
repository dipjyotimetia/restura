import { useCallback, useRef, useState } from 'react';
import {
  runCollection,
  type CollectionRunResult,
  type RequestCompleteInfo,
  type RunProgress,
} from '../lib/collectionRunner';
import type { RunnableRequest } from '../lib/flattenRunnables';
import type { IterationRow } from '../lib/dataLoader';
import type { Collection, Environment } from '@/types';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useCollectionRunStore } from '@/store/useCollectionRunStore';
import {
  useConsoleStore,
  type ConsoleLog,
  type ConsoleProtocol,
  type ConsoleTest,
} from '@/store/useConsoleStore';

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
}

/** env (enabled) layered first, then collection.variables override — matches the CLI. */
function buildBaseVars(env: Environment | null, collection: Collection): Record<string, string> {
  const vars: Record<string, string> = {};
  if (env) {
    for (const v of env.variables) if (v.enabled) vars[v.key] = v.value;
  }
  for (const v of collection.variables ?? []) {
    if (v.enabled) vars[v.key] = v.value;
  }
  return vars;
}

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

  const start = useCallback((args: StartRunArgs) => {
    if (abortRef.current) return;
    setProgress(null);
    setRunning(true);
    lastEmit.current = 0;
    const ac = new AbortController();
    abortRef.current = ac;

    const env =
      useEnvironmentStore.getState().environments.find((e) => e.id === args.environmentId) ?? null;
    const baseVars = buildBaseVars(env, args.collection);

    void runCollection(
      {
        collection: args.collection,
        scopeName: args.scopeName,
        runnables: args.runnables,
        baseVars,
        iterations: args.iterations,
        dataRows: args.dataRows,
        delayMs: args.delayMs,
        stopOnFailure: args.stopOnFailure,
      },
      (p) => {
        const now = performance.now();
        if (p.done || now - lastEmit.current > 100) {
          lastEmit.current = now;
          setProgress(p);
        }
      },
      ac.signal,
      pushConsoleEntry
    )
      .then((result: CollectionRunResult) => {
        useCollectionRunStore.getState().addRun(result);
      })
      .finally(() => {
        abortRef.current = null;
        setRunning(false);
      });
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { running, progress, start, stop };
}
