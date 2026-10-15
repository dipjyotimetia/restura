import type { GrpcSchemaDiff } from '@shared/protocol/grpc-schema-drift';
import { useCallback, useState } from 'react';
import { reflectionSnapshotDecision, stampSnapshot } from '@/features/grpc/lib/grpcSchemaSnapshot';
import { useActiveTab } from '@/store/selectors';
import { useRequestStore } from '@/store/useRequestStore';
import type { GrpcSchemaSnapshot, ReflectionServiceInfo } from '@/types';

export interface GrpcSchemaDriftState {
  /** Snapshot currently saved on the request (what the diff is relative to). */
  saved: GrpcSchemaSnapshot | undefined;
  /** Fresh reflected snapshot awaiting acceptance. */
  next: GrpcSchemaSnapshot;
  diff: GrpcSchemaDiff;
}

export interface UseGrpcSchemaDrift {
  /** Pending drift for the active tab, or null. */
  drift: GrpcSchemaDriftState | null;
  /** Feed a reflected service selection (writes, keeps, or raises drift). */
  onServiceReflected: (service: ReflectionServiceInfo) => void;
  /** Persist an uploaded schema (`.proto`, multi-file or descriptor set) as the stamped snapshot. */
  saveUpload: (schema: GrpcSchemaSnapshot) => void;
  /** Replace the saved snapshot with the reflected one. */
  accept: () => void;
  /** Keep the saved snapshot; hide the notice until the next reflect. */
  dismiss: () => void;
}

/**
 * Owns the gRPC request's schema snapshot lifecycle in the builder (#871,
 * #937): first reflection writes a stamped snapshot; a later reflection whose
 * schema differs is held as pending drift — with a breaking / non-breaking
 * diff — until the user accepts it, so a saved request never silently moves to
 * a changed server schema. Drift state is transient (not persisted) and
 * scoped to the tab it was raised on.
 */
export function useGrpcSchemaDrift(): UseGrpcSchemaDrift {
  const activeTabId = useActiveTab()?.id;
  const updateRequest = useRequestStore((s) => s.updateRequest);
  // Keyed by tab id so a reflect/upload on one tab never replaces or clears
  // drift still pending on another.
  const [pending, setPending] = useState<Record<string, GrpcSchemaDriftState>>({});

  const clearTab = useCallback((tabId: string | null | undefined) => {
    if (!tabId) return;
    setPending((current) => {
      if (!(tabId in current)) return current;
      const { [tabId]: _cleared, ...rest } = current;
      return rest;
    });
  }, []);

  const onServiceReflected = useCallback(
    (service: ReflectionServiceInfo) => {
      const state = useRequestStore.getState();
      const tab = state.tabs.find((t) => t.id === state.activeTabId);
      const decision = reflectionSnapshotDecision(service, tab?.request);
      if (decision.action === 'drift' && tab) {
        const saved = tab.request.type === 'grpc' ? tab.request.schema : undefined;
        setPending((current) => ({
          ...current,
          [tab.id]: { saved, next: decision.snapshot, diff: decision.diff },
        }));
        return;
      }
      if (decision.action === 'write') updateRequest({ schema: decision.snapshot });
      clearTab(tab?.id);
    },
    [updateRequest, clearTab]
  );

  const saveUpload = useCallback(
    (schema: GrpcSchemaSnapshot) => {
      updateRequest({ schema: stampSnapshot(schema) });
      clearTab(useRequestStore.getState().activeTabId);
    },
    [updateRequest, clearTab]
  );

  const visible = activeTabId ? (pending[activeTabId] ?? null) : null;

  const accept = useCallback(() => {
    if (visible) updateRequest({ schema: visible.next });
    clearTab(activeTabId);
  }, [visible, activeTabId, updateRequest, clearTab]);

  const dismiss = useCallback(() => clearTab(activeTabId), [activeTabId, clearTab]);

  return { drift: visible, onServiceReflected, saveUpload, accept, dismiss };
}
