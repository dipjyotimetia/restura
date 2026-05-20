import type { Request, RequestTab, Response, TabModeOverride } from '@/types';
import { v4 as uuidv4 } from 'uuid';

export function createTabFromRequest(
  request: Request,
  options: { savedRequestId?: string; modeOverride?: TabModeOverride } = {}
): RequestTab {
  const tab: RequestTab = {
    id: `tab_${uuidv4()}`,
    request,
    isDirty: false,
  };
  if (options.savedRequestId !== undefined) {
    tab.savedRequestId = options.savedRequestId;
  }
  if (options.modeOverride !== undefined) {
    tab.modeOverride = options.modeOverride;
  }
  return tab;
}

export function findTabIndex(tabs: RequestTab[], id: string | null): number {
  if (id === null) return -1;
  return tabs.findIndex((t) => t.id === id);
}

export interface LegacyRequestState {
  currentRequest: Request | null;
  httpRequest: Request | null;
  grpcRequest: Request | null;
  sseRequest: Request | null;
  mcpRequest: Request | null;
  currentResponse: Response | null;
}

export interface MigratedRequestState {
  tabs: RequestTab[];
  activeTabId: string | null;
}

export function migrateLegacyStateToTabs(legacy: LegacyRequestState): MigratedRequestState {
  if (!legacy.currentRequest) {
    return { tabs: [], activeTabId: null };
  }
  const tab = createTabFromRequest(legacy.currentRequest);
  if (
    legacy.currentResponse &&
    legacy.currentResponse.requestId === legacy.currentRequest.id
  ) {
    tab.response = legacy.currentResponse;
  }
  return { tabs: [tab], activeTabId: tab.id };
}
