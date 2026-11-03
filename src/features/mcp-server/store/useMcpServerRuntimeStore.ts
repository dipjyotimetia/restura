/**
 * In-memory runtime state of the MCP control server (ADR 0041): server
 * status, the queue of approval cards and secret prompts waiting on the user,
 * and the activity log. Deliberately NOT persisted — none of it should
 * survive a reload (a parked call dies with the renderer anyway), and the
 * bearer token must never reach disk through renderer storage.
 *
 * Resolver callbacks for pending prompts live in module-level maps, not in
 * Zustand state, so state stays serialisable and devtools-safe.
 */

import type { ControlServerStatus } from '@shared/mcp-server/control-bridge';
import type { ToolTier } from '@shared/mcp-server/control-tools';
import { create } from 'zustand';

export type ApprovalDecision = 'approved' | 'denied' | 'timeout' | 'cancelled';

export interface PendingApproval {
  callId: string;
  tool: string;
  tier: ToolTier;
  title: string;
  /** Human-readable lines describing exactly what will change or be sent. */
  details: string[];
  client?: string;
  createdAt: number;
}

export interface PendingSecretPrompt {
  callId: string;
  environmentName: string;
  key: string;
  reason: string;
  client?: string;
  createdAt: number;
}

export type ActivityStatus = 'applied' | 'denied' | 'refused' | 'failed' | 'undone';

export interface ActivityEntry {
  id: string;
  at: number;
  tool: string;
  tier: ToolTier;
  client?: string;
  summary: string;
  status: ActivityStatus;
  /** Short reason for refused / failed / denied entries. */
  detail?: string;
  /** True while an Undo is available for this entry. */
  undoable: boolean;
}

export const MAX_ACTIVITY_ENTRIES = 200;

/** How an agent launches `--mcp-server` for this install (from main). */
export interface AgentLaunch {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface McpServerRuntimeState {
  status: ControlServerStatus;
  /** Bearer token, memory only — for the copyable HTTP client config. */
  token: string | null;
  lastError: string | null;
  launch: AgentLaunch | null;
  approvals: PendingApproval[];
  secretPrompts: PendingSecretPrompt[];
  activity: ActivityEntry[];

  setStatus: (status: ControlServerStatus, token?: string | null) => void;
  setLastError: (message: string | null) => void;
  setLaunch: (launch: AgentLaunch) => void;
  pushActivity: (entry: ActivityEntry) => void;
  updateActivity: (id: string, patch: Partial<ActivityEntry>) => void;
  clearActivity: () => void;
}

const approvalResolvers = new Map<string, (decision: ApprovalDecision) => void>();
const secretResolvers = new Map<string, (value: string | null) => void>();

export const useMcpServerRuntimeStore = create<McpServerRuntimeState>()((set) => ({
  status: { running: false, inFlight: 0 },
  token: null,
  lastError: null,
  launch: null,
  approvals: [],
  secretPrompts: [],
  activity: [],

  setStatus: (status, token) =>
    set((state) => ({ status, token: token === undefined ? state.token : token })),
  setLastError: (lastError) => set({ lastError }),
  setLaunch: (launch) => set({ launch }),
  pushActivity: (entry) =>
    set((state) => ({ activity: [entry, ...state.activity].slice(0, MAX_ACTIVITY_ENTRIES) })),
  updateActivity: (id, patch) =>
    set((state) => ({
      activity: state.activity.map((e) => (e.id === id ? { ...e, ...patch } : e)),
    })),
  clearActivity: () => set({ activity: [] }),
}));

/** Queue an approval card; resolves when the user decides or it is settled elsewhere. */
export function enqueueApproval(
  approval: PendingApproval,
  timeoutMs: number
): Promise<ApprovalDecision> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => settleApproval(approval.callId, 'timeout'), timeoutMs);
    approvalResolvers.set(approval.callId, (decision) => {
      clearTimeout(timer);
      resolve(decision);
    });
    useMcpServerRuntimeStore.setState((s) => ({ approvals: [...s.approvals, approval] }));
  });
}

/** Settle an approval card (user click, timeout, or cancellation from main). Idempotent. */
export function settleApproval(callId: string, decision: ApprovalDecision): void {
  const resolve = approvalResolvers.get(callId);
  approvalResolvers.delete(callId);
  useMcpServerRuntimeStore.setState((s) => ({
    approvals: s.approvals.filter((a) => a.callId !== callId),
  }));
  resolve?.(decision);
}

/** Queue a secret prompt; resolves with the typed value, or null when declined. */
export function enqueueSecretPrompt(
  prompt: PendingSecretPrompt,
  timeoutMs: number
): Promise<string | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => settleSecretPrompt(prompt.callId, null), timeoutMs);
    secretResolvers.set(prompt.callId, (value) => {
      clearTimeout(timer);
      resolve(value);
    });
    useMcpServerRuntimeStore.setState((s) => ({ secretPrompts: [...s.secretPrompts, prompt] }));
  });
}

export function settleSecretPrompt(callId: string, value: string | null): void {
  const resolve = secretResolvers.get(callId);
  secretResolvers.delete(callId);
  useMcpServerRuntimeStore.setState((s) => ({
    secretPrompts: s.secretPrompts.filter((p) => p.callId !== callId),
  }));
  resolve?.(value);
}

/** Drop everything pending (server stopped / renderer unmounting). */
export function settleAllPending(): void {
  for (const callId of [...approvalResolvers.keys()]) settleApproval(callId, 'cancelled');
  for (const callId of [...secretResolvers.keys()]) settleSecretPrompt(callId, null);
}
