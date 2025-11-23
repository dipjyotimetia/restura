import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { v4 as uuidv4 } from 'uuid';
import { Response as ApiResponse, HttpRequest } from '@/types';

export interface ConsoleLog {
  type: 'log' | 'error' | 'warn' | 'info';
  message: string;
  timestamp: number;
}

export interface ConsoleTest {
  name: string;
  passed: boolean;
  error?: string;
}

export interface ConsoleEntry {
  id: string;
  timestamp: number;
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: string;
  };
  response: ApiResponse;
  scriptLogs?: ConsoleLog[];
  tests?: ConsoleTest[];
}

interface ConsoleState {
  entries: ConsoleEntry[];
  selectedEntryId: string | null;
  isExpanded: boolean;
  panelHeight: number;
  activeTab: 'network' | 'scripts';
  searchFilter: string;

  // Actions
  addEntry: (entry: Omit<ConsoleEntry, 'id'>) => void;
  clearEntries: () => void;
  selectEntry: (id: string | null) => void;
  setExpanded: (expanded: boolean) => void;
  setPanelHeight: (height: number) => void;
  setActiveTab: (tab: 'network' | 'scripts') => void;
  setSearchFilter: (filter: string) => void;
}

export const useConsoleStore = create<ConsoleState>()(
  persist(
    (set) => ({
      entries: [],
      selectedEntryId: null,
      isExpanded: true,
      panelHeight: 250,
      activeTab: 'network',
      searchFilter: '',

      addEntry: (entry) =>
        set((state) => {
          const newEntry: ConsoleEntry = {
            ...entry,
            id: uuidv4(),
          };
          // Keep last 100 entries to prevent memory issues
          const newEntries = [newEntry, ...state.entries].slice(0, 100);
          return {
            entries: newEntries,
            selectedEntryId: newEntry.id,
          };
        }),

      clearEntries: () =>
        set({
          entries: [],
          selectedEntryId: null,
        }),

      selectEntry: (id) => set({ selectedEntryId: id }),

      setExpanded: (expanded) => set({ isExpanded: expanded }),

      setPanelHeight: (height) => set({ panelHeight: height }),

      setActiveTab: (tab) => set({ activeTab: tab }),

      setSearchFilter: (filter) => set({ searchFilter: filter }),
    }),
    {
      name: 'console-storage',
      // Only persist UI preferences, not entries (session-based)
      partialize: (state) => ({
        isExpanded: state.isExpanded,
        panelHeight: state.panelHeight,
        activeTab: state.activeTab,
      }),
    }
  )
);

// Helper to create console entry from request/response
export function createConsoleEntry(
  request: HttpRequest,
  response: ApiResponse,
  sentHeaders: Record<string, string>,
  scriptLogs?: ConsoleLog[],
  tests?: ConsoleTest[]
): Omit<ConsoleEntry, 'id'> {
  return {
    timestamp: Date.now(),
    request: {
      method: request.method,
      url: request.url,
      headers: sentHeaders,
      body: request.body.type !== 'none' ? request.body.raw : undefined,
    },
    response,
    scriptLogs,
    tests,
  };
}
