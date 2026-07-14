import type { AgentSuite, AgentSuiteReport } from '@shared/agent-lab';
import { create } from 'zustand';
import { runDesktopAgentSuite } from '../lib/agentRuntime';
import { useAiLabStore } from '../store/useAiLabStore';
import type { AiLabProviderConfig } from '../types';
import { type AiLabReportEnvelope, createAgentSuiteReportEnvelope } from './reportEnvelope';
import {
  type AiLabReportRepository,
  resetAiLabReportRepositoryForTests,
  setAiLabReportRepositoryForTests,
} from './reportRepository';
import { sanitizeAgentSuiteReportForPersistence } from './reportSanitizer';
import { isRunCancelledWithResult, RunEngine } from './runEngine';

type AgentEnvelope = Extract<AiLabReportEnvelope, { kind: 'agent-suite' }>;
type Approval = NonNullable<Parameters<typeof runDesktopAgentSuite>[2]>['requestApproval'];

interface AgentRunLiveState {
  running: boolean;
  status: string;
  progress: number;
  activeJobId: string | null;
  completedReport: AgentEnvelope | null;
  persistenceError: string | null;
  persistedReportId: string | null;
  navigationReportId: string | null;
}

const initialState: AgentRunLiveState = {
  running: false,
  status: 'Ready',
  progress: 0,
  activeJobId: null,
  completedReport: null,
  persistenceError: null,
  persistedReportId: null,
  navigationReportId: null,
};

export const useAgentRunLiveStore = create<AgentRunLiveState>()(() => initialState);
const engine = new RunEngine<AgentSuiteReport>();
let ownerSequence = 0;
let currentOwner: number | null = null;
const mountedOwners = new Set<number>();

export function registerAgentRunOwner(): () => void {
  const owner = ++ownerSequence;
  mountedOwners.add(owner);
  currentOwner = owner;
  return () => {
    mountedOwners.delete(owner);
    if (currentOwner === owner) currentOwner = null;
  };
}

export function setAgentRunRepositoryForTests(next: AiLabReportRepository): void {
  setAiLabReportRepositoryForTests(next);
}

export function resetAgentRunServiceForTests(): void {
  const active = useAgentRunLiveStore.getState().activeJobId;
  if (active) engine.cancel(active);
  resetAiLabReportRepositoryForTests();
  mountedOwners.clear();
  currentOwner = null;
  useAgentRunLiveStore.setState(initialState);
}

export function startAgentRun(
  suite: AgentSuite,
  providers: Record<string, AiLabProviderConfig>,
  requestApproval?: Approval
): boolean {
  const live = useAgentRunLiveStore.getState();
  if (
    live.running ||
    (live.completedReport !== null && live.completedReport.id !== live.persistedReportId)
  )
    return false;
  const started = engine.start(
    'agent-suite',
    (context) =>
      runDesktopAgentSuite(suite, providers, {
        signal: context.signal,
        reportProgress: (progress) => {
          context.reportProgress(progress);
          if (useAgentRunLiveStore.getState().activeJobId === context.jobId)
            useAgentRunLiveStore.setState({ progress });
        },
        ...(requestApproval ? { requestApproval } : {}),
      }),
    {
      classifyResult: (report) => report.status,
      cancellationResult: (report) => ({ ...report, status: 'cancelled' }),
    }
  );
  useAgentRunLiveStore.setState({
    running: true,
    status: 'Running agent trials…',
    progress: 0,
    activeJobId: started.jobId,
    completedReport: null,
    persistenceError: null,
    navigationReportId: null,
  });
  void finishAgentRun(started.jobId, suite, started.result, currentOwner);
  return true;
}

export function cancelAgentRun(): boolean {
  const jobId = useAgentRunLiveStore.getState().activeJobId;
  if (!jobId) return false;
  const cancelled = engine.cancel(jobId);
  if (cancelled) useAgentRunLiveStore.setState({ status: 'CANCELLING…' });
  return cancelled;
}

export async function retryAgentReportPersistence(): Promise<boolean> {
  const report = useAgentRunLiveStore.getState().completedReport;
  if (!report) return false;
  const persisted = await persistReport(report);
  if (persisted && currentOwner !== null && mountedOwners.has(currentOwner)) {
    useAgentRunLiveStore.setState({ navigationReportId: report.id });
  }
  return persisted;
}

async function finishAgentRun(
  jobId: string,
  suite: AgentSuite,
  result: Promise<AgentSuiteReport>,
  owner: number | null
): Promise<void> {
  try {
    const report = await result;
    if (useAgentRunLiveStore.getState().activeJobId !== jobId) return;
    await completeAgentRun(jobId, suite, report, owner, report.status !== 'cancelled');
  } catch (cause) {
    if (useAgentRunLiveStore.getState().activeJobId !== jobId) return;
    if (isRunCancelledWithResult<AgentSuiteReport>(cause)) {
      await completeAgentRun(jobId, suite, cause.result, owner, false);
      return;
    }
    const name = typeof cause === 'object' && cause && 'name' in cause ? cause.name : undefined;
    useAgentRunLiveStore.setState({
      status: name === 'AbortError' ? 'CANCELLED' : errorMessage(cause),
    });
  } finally {
    if (useAgentRunLiveStore.getState().activeJobId === jobId) {
      useAgentRunLiveStore.setState({ running: false, activeJobId: null });
    }
    engine.release(jobId);
  }
}

async function completeAgentRun(
  jobId: string,
  suite: AgentSuite,
  report: AgentSuiteReport,
  owner: number | null,
  navigate: boolean
): Promise<void> {
  const snapshot = engine.get(jobId);
  const sanitized = sanitizeAgentSuiteReportForPersistence(
    createAgentSuiteReportEnvelope(suite, report, {
      id: jobId,
      startedAt: snapshot?.startedAt ?? Date.now(),
      finishedAt: snapshot?.finishedAt ?? Date.now(),
    }) as AgentEnvelope
  );
  // The sanitized envelope owns everything needed below; release the raw
  // runner result/controller before an IndexedDB write can stall or fail.
  engine.release(jobId);
  useAgentRunLiveStore.setState({
    completedReport: sanitized,
    status: report.status.toUpperCase(),
  });
  const persisted = await persistReport(sanitized);
  if (navigate && persisted && owner !== null && mountedOwners.has(owner)) {
    useAgentRunLiveStore.setState({ navigationReportId: sanitized.id });
  }
}

async function persistReport(report: AgentEnvelope): Promise<boolean> {
  try {
    await useAiLabStore.getState().saveRunReport(report);
    useAgentRunLiveStore.setState({ persistenceError: null, persistedReportId: report.id });
    return true;
  } catch (cause) {
    useAgentRunLiveStore.setState({
      persistenceError: `persistence failed: ${errorMessage(cause)}`,
    });
    return false;
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
