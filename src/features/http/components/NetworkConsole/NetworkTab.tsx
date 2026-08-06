'use client';

import { Network } from 'lucide-react';
import { useMemo, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { toast } from 'sonner';
import { useShallow } from 'zustand/react/shallow';
import { type CodeGeneratorType, codeGenerators } from '@/lib/shared/codeGenerators';
import { useActiveTab } from '@/store/selectors';
import { useMcpStore } from '@/features/mcp/store/useMcpStore';
import type { McpRequest } from '@/types';
import {
  entryToCurl,
  entryToGraphqlRequest,
  entryToGrpcRequest,
  entryToHttpRequest,
  getConsoleEntryActions,
  useConsoleStore,
} from '@/store/useConsoleStore';
import { useRequestStore } from '@/store/useRequestStore';
import EntryCompareDialog from './EntryCompareDialog';
import EntryExpandDialog from './EntryExpandDialog';
import NetworkEntryDetail from './NetworkEntryDetail';
import NetworkEntryList from './NetworkEntryList';
import { useNetworkFilters } from './useNetworkFilters';

export default function NetworkTab() {
  // This tab intentionally subscribes only to its store slice. Frames can update
  // many times per second and must not re-run the list derivations below.
  const {
    entries,
    selectedEntryId,
    selectEntry,
    searchFilter,
    setSearchFilter,
    statusFilter,
    setStatusFilter,
    protocolFilter,
    setProtocolFilter,
    runFilter,
    setRunFilter,
    removeEntry,
    togglePin,
  } = useConsoleStore(
    useShallow((state) => ({
      entries: state.entries,
      selectedEntryId: state.selectedEntryId,
      selectEntry: state.selectEntry,
      searchFilter: state.searchFilter,
      setSearchFilter: state.setSearchFilter,
      statusFilter: state.statusFilter,
      setStatusFilter: state.setStatusFilter,
      protocolFilter: state.protocolFilter,
      setProtocolFilter: state.setProtocolFilter,
      runFilter: state.runFilter,
      setRunFilter: state.setRunFilter,
      removeEntry: state.removeEntry,
      togglePin: state.togglePin,
    }))
  );
  const openTab = useRequestStore((state) => state.openTab);
  const openTabWithMode = useRequestStore((state) => state.openTabWithMode);
  const updateRequest = useRequestStore((state) => state.updateRequest);
  const updateRequestForTab = useRequestStore((state) => state.updateRequestForTab);
  const createMcpConnection = useMcpStore((state) => state.createConnection);
  const appendMcpLog = useMcpStore((state) => state.appendLog);
  const activeTab = useActiveTab();
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [compareDialogOpen, setCompareDialogOpen] = useState(false);
  const [expandOpen, setExpandOpen] = useState(false);

  const filters = useNetworkFilters({
    entries,
    searchFilter,
    statusFilter,
    protocolFilter,
    runFilter,
  });
  const selectedEntry = useMemo(
    () => entries.find((entry) => entry.id === selectedEntryId),
    [entries, selectedEntryId]
  );
  const compareEntries = useMemo(
    () =>
      compareIds
        .map((id) => entries.find((entry) => entry.id === id))
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)),
    [compareIds, entries]
  );

  const toggleCompare = (id: string) => {
    setCompareIds((previous) => {
      if (previous.includes(id)) return previous.filter((current) => current !== id);
      return previous.length >= 2 ? [previous[1]!, id] : [...previous, id];
    });
  };

  const handleCopyAsCode = async (generatorKey: CodeGeneratorType) => {
    if (!selectedEntry || !getConsoleEntryActions(selectedEntry).copyCode) return;
    try {
      const request = entryToHttpRequest(selectedEntry) ?? entryToGraphqlRequest(selectedEntry);
      if (!request) return;
      const resolvedParams: Record<string, string> = {};
      try {
        for (const [key, value] of new URL(request.url).searchParams) resolvedParams[key] = value;
      } catch {
        // Generators already handle an empty parameter map for malformed URLs.
      }
      const code = codeGenerators[generatorKey].generate({
        request,
        resolvedUrl: request.url,
        resolvedHeaders: selectedEntry.request.headers,
        resolvedParams,
      });
      await navigator.clipboard.writeText(code);
      toast.success(`Copied as ${codeGenerators[generatorKey].name}`);
    } catch (error) {
      toast.error(`Failed to copy: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  };

  const handleOpenSafeDraft = () => {
    if (!selectedEntry) return;
    const draft = selectedEntry.nativeDraft;
    if (!draft) return;

    if (draft.kind === 'http') {
      const request = entryToHttpRequest(selectedEntry);
      if (!request) return;
      if (activeTab?.request.type !== 'http') {
        openTab(request, { switchTo: true });
      } else {
        updateRequest({
          method: request.method,
          url: request.url,
          headers: request.headers,
          params: request.params,
          body: request.body,
          auth: request.auth,
        });
      }
      toast.success('Opened safe HTTP draft');
      return;
    }

    if (draft.kind === 'graphql') {
      const request = entryToGraphqlRequest(selectedEntry);
      if (!request) return;
      const tabId = openTabWithMode('graphql');
      updateRequestForTab(tabId, request);
      toast.success('Opened safe GraphQL draft');
      return;
    }

    if (draft.kind === 'grpc') {
      const request = entryToGrpcRequest(selectedEntry);
      if (!request) return;
      openTab(request, { switchTo: true });
      toast.success('Opened gRPC draft — load reflection or a proto before sending');
      return;
    }

    const connectionId = createMcpConnection(
      draft.url,
      draft.transport,
      Object.entries(draft.headers).map(([key, value]) => ({
        id: uuidv4(),
        key,
        value,
        enabled: true,
      }))
    );
    if (draft.method) {
      appendMcpLog(connectionId, {
        method: draft.method,
        ...(draft.params !== undefined && { params: draft.params }),
        error: 'Captured console evidence — not invoked.',
        durationMs: 0,
      });
    }
    const request: McpRequest = {
      id: uuidv4(),
      name: 'Console MCP Draft',
      type: 'mcp',
      url: draft.url,
      transport: draft.transport,
      headers: Object.entries(draft.headers).map(([key, value]) => ({
        id: uuidv4(),
        key,
        value,
        enabled: true,
      })),
      auth: { type: 'none' },
    };
    openTab(request, { switchTo: true });
    toast.success('Created disconnected MCP draft');
  };

  const handleCopyCurl = async () => {
    if (!selectedEntry || !getConsoleEntryActions(selectedEntry).copyCode) return;
    try {
      await navigator.clipboard.writeText(entryToCurl(selectedEntry));
      toast.success('Copied as cURL');
    } catch {
      toast.error('Failed to copy');
    }
  };

  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground py-8">
        <Network className="h-10 w-10 mb-3 opacity-30" />
        <p className="font-medium text-sm">No requests yet</p>
        <p className="text-xs mt-1">Send a request to see it here</p>
      </div>
    );
  }

  return (
    <div className="flex h-full">
      <NetworkEntryList
        {...filters}
        compareIds={compareIds}
        protocolFilter={protocolFilter}
        removeEntry={removeEntry}
        runFilter={runFilter}
        searchFilter={searchFilter}
        selectedEntryId={selectedEntryId}
        selectEntry={selectEntry}
        setProtocolFilter={setProtocolFilter}
        setRunFilter={setRunFilter}
        setSearchFilter={setSearchFilter}
        setStatusFilter={setStatusFilter}
        statusFilter={statusFilter}
        toggleCompare={toggleCompare}
        togglePin={togglePin}
      />
      <div className="flex-1 min-w-0">
        <NetworkEntryDetail
          compareCount={compareEntries.length}
          entry={selectedEntry}
          onCompare={() => setCompareDialogOpen(true)}
          onCopyAsCode={handleCopyAsCode}
          onCopyCurl={handleCopyCurl}
          onExpand={() => setExpandOpen(true)}
          onOpenSafeDraft={handleOpenSafeDraft}
        />
      </div>
      <EntryCompareDialog
        open={compareDialogOpen}
        onOpenChange={setCompareDialogOpen}
        left={compareEntries[0] ?? null}
        right={compareEntries[1] ?? null}
      />
      <EntryExpandDialog
        open={expandOpen}
        onOpenChange={setExpandOpen}
        entry={selectedEntry ?? null}
      />
    </div>
  );
}
