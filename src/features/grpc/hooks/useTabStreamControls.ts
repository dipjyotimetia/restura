import { useCallback, useEffect, useRef, useState } from 'react';
import type { BuilderStreamControl } from '../components/runBuilderStream';

interface TabStreamRun {
  /** The send that opened this stream — a stale send can't clear a newer one's controls. */
  runId: number;
  control: BuilderStreamControl;
}

/**
 * Live gRPC stream controls, kept PER TAB. One GrpcRequestBuilder instance
 * serves every gRPC tab, so tab B's Send / End / Cancel must never drive tab
 * A's stream, and A's stream ending must not drop B's controls. Every open
 * stream is cancelled when the builder unmounts.
 */
export function useTabStreamControls(activeTabId: string | undefined) {
  const [runs, setRuns] = useState<Readonly<Record<string, TabStreamRun>>>({});
  const runsRef = useRef(runs);
  useEffect(() => {
    runsRef.current = runs;
  }, [runs]);

  useEffect(() => {
    return () => {
      for (const { control } of Object.values(runsRef.current)) {
        try {
          control.cancelStream();
        } catch {
          /* ignore cleanup errors */
        }
      }
    };
  }, []);

  /** Set `tabId`'s controls for send `runId`, or clear them (`null`) if that send still owns them. */
  const setFor = useCallback(
    (tabId: string, runId: number, control: BuilderStreamControl | null) =>
      setRuns((prev) => {
        if (control) return { ...prev, [tabId]: { runId, control } };
        if (prev[tabId]?.runId !== runId) return prev;
        const { [tabId]: _cleared, ...rest } = prev;
        return rest;
      }),
    []
  );

  const activeRun = activeTabId ? runs[activeTabId] : undefined;
  return { activeRun, activeControl: activeRun?.control ?? null, setFor };
}
