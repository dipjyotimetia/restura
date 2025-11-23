'use client';

import { useState, useCallback, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useShallow } from 'zustand/react/shallow';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useHistoryStore } from '@/store/useHistoryStore';
import { useRequestStore } from '@/store/useRequestStore';
import { selectFavoriteIds, selectHistoryCount } from '@/store/selectors';
import { FolderPlus, History, Star, X, MoreVertical, Download, Trash2, Search, PanelLeftClose, PanelLeftOpen, GitBranch } from 'lucide-react';
import { exportToPostman, exportToInsomnia, downloadJSON } from '@/features/collections/lib/exporters';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { cn } from '@/lib/shared/utils';
import { Workflow } from '@/types';
import { WorkflowManager } from '@/features/workflows/components/WorkflowManager';
import { WorkflowBuilder } from '@/features/workflows/components/WorkflowBuilder';
import { WorkflowExecutor } from '@/features/workflows/components/WorkflowExecutor';
import { METHOD_COLORS, SIDEBAR_WIDTH } from '@/lib/shared/constants';
import { Stagger, StaggerItem } from '@/components/ui/motion';
import { withErrorBoundary } from '@/components/shared/ErrorBoundary';

interface SidebarProps {
  onClose: () => void;
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;
}

const HISTORY_PAGE_SIZE = 20;

function Sidebar({ onClose, isCollapsed = false, onToggleCollapse }: SidebarProps) {
  const { collections, createNewCollection, addCollection, deleteCollection } = useCollectionStore();

  // Use granular selectors for history to minimize re-renders
  const toggleFavorite = useHistoryStore(state => state.toggleFavorite);
  const getHistoryById = useHistoryStore(state => state.getHistoryById);
  const favorites = useHistoryStore(useShallow(selectFavoriteIds));
  const totalHistoryCount = useHistoryStore(selectHistoryCount);

  const { setCurrentRequest } = useRequestStore();
  const [activeTab, setActiveTab] = useState('collections');
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [collectionToDelete, setCollectionToDelete] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [methodFilter, setMethodFilter] = useState<string | null>(null);
  const [visibleHistoryCount, setVisibleHistoryCount] = useState(HISTORY_PAGE_SIZE);
  const [selectedWorkflow, setSelectedWorkflow] = useState<Workflow | null>(null);
  const [runningWorkflow, setRunningWorkflow] = useState<Workflow | null>(null);

  // Get visible history items using selector
  const visibleHistory = useHistoryStore(
    useShallow((state) => state.history.slice(0, visibleHistoryCount))
  );

  // Filter collections based on search query
  const filteredCollections = useMemo(() => {
    if (!searchQuery) return collections;
    const query = searchQuery.toLowerCase();
    return collections.filter(
      (c) =>
        c.name.toLowerCase().includes(query) ||
        c.items.some((item) => item.name.toLowerCase().includes(query))
    );
  }, [collections, searchQuery]);

  // Filter history based on search query and method filter
  const filteredHistory = useMemo(() => {
    let filtered = visibleHistory;

    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter((item) => {
        if (item.request.type === 'http') {
          return (
            item.request.url.toLowerCase().includes(query) ||
            item.request.method.toLowerCase().includes(query)
          );
        }
        return item.request.service?.toLowerCase().includes(query);
      });
    }

    if (methodFilter) {
      filtered = filtered.filter((item) => {
        if (item.request.type === 'http') {
          return item.request.method === methodFilter;
        }
        return false;
      });
    }

    return filtered;
  }, [visibleHistory, searchQuery, methodFilter]);

  const hasMoreHistory = visibleHistoryCount < totalHistoryCount;

  const handleLoadMore = useCallback(() => {
    setVisibleHistoryCount(prev => prev + HISTORY_PAGE_SIZE);
  }, []);

  const handleNewCollection = useCallback(() => {
    const newCollection = createNewCollection('New Collection');
    addCollection(newCollection);
  }, [createNewCollection, addCollection]);

  const handleExportCollection = useCallback(
    (collectionId: string, format: 'postman' | 'insomnia') => {
      const collection = collections.find((c) => c.id === collectionId);
      if (!collection) return;

      if (format === 'postman') {
        const postmanData = exportToPostman(collection);
        downloadJSON(postmanData, `${collection.name}.postman_collection.json`);
      } else {
        const insomniaData = exportToInsomnia(collection);
        downloadJSON(insomniaData, `${collection.name}.insomnia.json`);
      }
    },
    [collections]
  );

  const handleDeleteClick = useCallback((collectionId: string) => {
    setCollectionToDelete(collectionId);
    setDeleteDialogOpen(true);
  }, []);

  const handleConfirmDelete = useCallback(() => {
    if (collectionToDelete) {
      deleteCollection(collectionToDelete);
      setCollectionToDelete(null);
    }
    setDeleteDialogOpen(false);
  }, [collectionToDelete, deleteCollection]);

  const handleLoadHistoryItem = useCallback(
    (itemId: string) => {
      const item = getHistoryById(itemId);
      if (item) {
        setCurrentRequest(item.request);
      }
    },
    [getHistoryById, setCurrentRequest]
  );

  return (
    <TooltipProvider delayDuration={300}>
      <aside
        className={cn(
          "border-r border-border bg-background flex flex-col relative z-40 transition-all duration-300 ease-out shadow-md",
          isCollapsed ? SIDEBAR_WIDTH.collapsed : SIDEBAR_WIDTH.expanded
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-3 border-b border-border bg-transparent">
          {!isCollapsed && (
            <div className="flex items-center gap-2">
              <div className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />
              <h2 className="font-semibold text-sm tracking-tight text-foreground">Workspace</h2>
            </div>
          )}
          <div className={cn("flex items-center gap-1", isCollapsed && "w-full justify-center")}>
            {onToggleCollapse && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={onToggleCollapse}
                    aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                    className="h-7 w-7"
                  >
                    {isCollapsed ? (
                      <PanelLeftOpen className="h-4 w-4" />
                    ) : (
                      <PanelLeftClose className="h-4 w-4" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">
                  <p>{isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}</p>
                </TooltipContent>
              </Tooltip>
            )}
            {!isCollapsed && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close sidebar" className="h-7 w-7">
                    <X className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Close sidebar</p>
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>

        {/* Collapsed View */}
        {isCollapsed ? (
          <div className="flex flex-col items-center gap-2 p-2 flex-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={activeTab === 'collections' ? 'secondary' : 'ghost'}
                  size="icon"
                  onClick={() => setActiveTab('collections')}
                  className="h-9 w-9"
                >
                  <FolderPlus className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">
                <p>Collections ({filteredCollections.length})</p>
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={activeTab === 'history' ? 'secondary' : 'ghost'}
                  size="icon"
                  onClick={() => setActiveTab('history')}
                  className="h-9 w-9"
                >
                  <History className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">
                <p>History ({filteredHistory.length})</p>
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={activeTab === 'workflows' ? 'secondary' : 'ghost'}
                  size="icon"
                  onClick={() => setActiveTab('workflows')}
                  className="h-9 w-9"
                >
                  <GitBranch className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">
                <p>Workflows</p>
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleNewCollection}
                  className="h-9 w-9 mt-auto"
                >
                  <FolderPlus className="h-4 w-4 text-primary" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">
                <p>New Collection</p>
              </TooltipContent>
            </Tooltip>
          </div>
        ) : (
          <>
            {/* Search Input */}
            <div className="p-3 border-b border-border/40 bg-muted/10">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  placeholder="Search..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-8 h-9 text-xs bg-background border-border/60 focus:bg-background focus:border-primary/30 transition-all"
                />
                {searchQuery && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7 hover:bg-transparent"
                    onClick={() => setSearchQuery('')}
                    aria-label="Clear search"
                  >
                    <X className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
                  </Button>
                )}
              </div>
            </div>

            <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col overflow-hidden">
              <div className="px-3 py-2 border-b border-border/40">
                <TabsList className="w-full grid grid-cols-3">
                  <TabsTrigger value="collections" className="text-xs">
                    Collections
                    {filteredCollections.length > 0 && (
                      <span className="ml-1 text-[10px] bg-primary/10 text-primary px-1 py-0.5 rounded-full tabular-nums font-bold">
                        {filteredCollections.length}
                      </span>
                    )}
                  </TabsTrigger>
                  <TabsTrigger value="history" className="text-xs">
                    History
                  </TabsTrigger>
                  <TabsTrigger value="workflows" className="text-xs">
                    Workflows
                  </TabsTrigger>
                </TabsList>
              </div>

              <TabsContent value="collections" className="flex-1 overflow-auto p-3 mt-0 min-h-0">
                <div className="flex flex-col gap-2">
                  <Button
                    onClick={handleNewCollection}
                    variant="outline"
                    size="sm"
                    className="w-full justify-start h-8 text-xs border-border hover:border-primary/50 hover:bg-primary/5 dark:hover:bg-primary/10 transition-all duration-200 shadow-sm hover:shadow"
                  >
                    <FolderPlus className="mr-2 h-3.5 w-3.5 text-primary" />
                    New Collection
                  </Button>

                  {filteredCollections.length === 0 ? (
                    <div className="text-center text-xs py-10 px-3">
                      <div className="mx-auto mb-3 h-12 w-12 rounded-xl bg-gradient-to-br from-primary/10 to-primary/5 flex items-center justify-center">
                        <FolderPlus className="h-6 w-6 text-primary/60" />
                      </div>
                      <p className="font-medium text-foreground">
                        {searchQuery ? 'No collections found' : 'No collections yet'}
                      </p>
                      <p className="text-xs mt-1 text-muted-foreground">
                        {searchQuery ? 'Try a different search term' : 'Create one to organize your requests'}
                      </p>
                    </div>
                  ) : (
                    <Stagger className="space-y-1.5">
                      {filteredCollections.map((collection) => (
                        <StaggerItem
                          key={collection.id}
                          className="group p-2.5 rounded-md bg-muted border border-border hover:border-primary/30 hover:bg-accent cursor-pointer flex items-center justify-between transition-all shadow-sm"
                        >
                          <div className="flex-1 flex items-center gap-2 min-w-0">
                            <FolderPlus className="h-3.5 w-3.5 text-primary shrink-0" />
                            <div className="min-w-0">
                              <span className="text-xs font-medium block truncate">{collection.name}</span>
                              <span className="text-[10px] text-muted-foreground">
                                {collection.items.length} {collection.items.length === 1 ? 'item' : 'items'}
                              </span>
                            </div>
                          </div>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 opacity-0 group-hover:opacity-100 shrink-0"
                                onClick={(e) => e.stopPropagation()}
                                aria-label="Collection options"
                              >
                                <MoreVertical className="h-3.5 w-3.5" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuSub>
                                <DropdownMenuSubTrigger className="text-xs">
                                  <Download className="mr-2 h-3.5 w-3.5" />
                                  Export
                                </DropdownMenuSubTrigger>
                                <DropdownMenuSubContent>
                                  <DropdownMenuItem onClick={() => handleExportCollection(collection.id, 'postman')} className="text-xs">
                                    Postman Collection
                                  </DropdownMenuItem>
                                  <DropdownMenuItem onClick={() => handleExportCollection(collection.id, 'insomnia')} className="text-xs">
                                    Insomnia Collection
                                  </DropdownMenuItem>
                                </DropdownMenuSubContent>
                              </DropdownMenuSub>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onClick={() => handleDeleteClick(collection.id)}
                                className="text-destructive focus:text-destructive text-xs"
                              >
                                <Trash2 className="mr-2 h-3.5 w-3.5" />
                                Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </StaggerItem>
                      ))}
                    </Stagger>
                  )}
                </div>
                <ConfirmDialog
                  open={deleteDialogOpen}
                  onOpenChange={setDeleteDialogOpen}
                  title="Delete Collection"
                  description="Are you sure you want to delete this collection? This action cannot be undone."
                  confirmText="Delete"
                  cancelText="Cancel"
                  onConfirm={handleConfirmDelete}
                  variant="destructive"
                />
              </TabsContent>

              <TabsContent value="history" className="flex-1 overflow-auto p-3 mt-0">
                {/* Method filter buttons */}
                {totalHistoryCount > 0 && (
                  <div className="flex flex-wrap gap-1.5 mb-3">
                    <Button
                      variant={methodFilter === null ? 'secondary' : 'ghost'}
                      size="sm"
                      className="h-6 text-[10px] px-2"
                      onClick={() => setMethodFilter(null)}
                    >
                      All
                    </Button>
                    {['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].map((method) => (
                      <Button
                        key={method}
                        variant={methodFilter === method ? 'secondary' : 'ghost'}
                        size="sm"
                        className={cn(
                          'h-6 text-[10px] font-mono px-2',
                          methodFilter === method && METHOD_COLORS[method]
                        )}
                        onClick={() => setMethodFilter(methodFilter === method ? null : method)}
                      >
                        {method}
                      </Button>
                    ))}
                  </div>
                )}

                {filteredHistory.length === 0 ? (
                  <div className="text-center text-xs py-10 px-3">
                    <div className="mx-auto mb-3 h-12 w-12 rounded-xl bg-gradient-to-br from-muted to-muted/50 flex items-center justify-center">
                      <History className="h-6 w-6 text-muted-foreground/60" />
                    </div>
                    <p className="font-medium text-foreground">
                      {searchQuery || methodFilter ? 'No matching requests' : 'No history yet'}
                    </p>
                    <p className="text-xs mt-1 text-muted-foreground">
                      {searchQuery || methodFilter
                        ? 'Try adjusting your filters'
                        : 'Send a request to see it here'}
                    </p>
                  </div>
                ) : (
                  <Stagger className="space-y-1.5">
                    {filteredHistory.map((item) => (
                      <StaggerItem
                        key={item.id}
                        className="group p-2.5 rounded-md bg-muted border border-border hover:border-primary/30 hover:bg-accent cursor-pointer transition-all shadow-sm"
                        onClick={() => handleLoadHistoryItem(item.id)}
                      >
                        <div className="flex items-center gap-1.5 mb-1.5">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6"
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleFavorite(item.id);
                            }}
                            aria-label={favorites.includes(item.id) ? 'Remove from favorites' : 'Add to favorites'}
                          >
                            <Star
                              className={cn(
                                "h-3.5 w-3.5 transition-all",
                                favorites.includes(item.id)
                                  ? 'text-amber-500 fill-amber-500 scale-110'
                                  : 'text-muted-foreground/50 group-hover:text-amber-500'
                              )}
                            />
                          </Button>
                          <span
                            className={cn(
                              'text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded',
                              item.request.type === 'http'
                                ? METHOD_COLORS[item.request.method] || 'bg-muted text-muted-foreground border border-border'
                                : 'bg-muted text-muted-foreground border border-border'
                            )}
                          >
                            {item.request.type === 'http' ? item.request.method : 'gRPC'}
                          </span>
                          {item.response && (
                            <span
                              className={cn(
                                'text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded tabular-nums',
                                item.response.status >= 200 && item.response.status < 300
                                  ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                                  : item.response.status >= 400
                                  ? 'bg-red-500/10 text-red-600 dark:text-red-400'
                                  : 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                              )}
                            >
                              {item.response.status}
                            </span>
                          )}
                        </div>
                        <p className="text-xs font-medium truncate pl-6 mb-1 text-foreground">
                          {item.request.type === 'http' ? item.request.url : item.request.service}
                        </p>
                        <span className="text-[10px] text-muted-foreground pl-6 flex items-center gap-1">
                          <History className="h-3 w-3" />
                          {new Date(item.timestamp).toLocaleString()}
                        </span>
                      </StaggerItem>
                    ))}
                  </Stagger>
                )}
                {hasMoreHistory && !searchQuery && !methodFilter && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full mt-3 text-xs"
                    onClick={handleLoadMore}
                  >
                    Load More ({totalHistoryCount - visibleHistoryCount} remaining)
                  </Button>
                )}
              </TabsContent>

              <TabsContent value="workflows" className="flex-1 overflow-auto p-3 mt-0">
                {filteredCollections.length === 0 ? (
                  <div className="text-center text-xs py-10 px-3">
                    <div className="mx-auto mb-3 h-12 w-12 rounded-xl bg-gradient-to-br from-primary/10 to-primary/5 flex items-center justify-center">
                      <GitBranch className="h-6 w-6 text-primary/60" />
                    </div>
                    <p className="font-medium text-foreground">No collections yet</p>
                    <p className="text-xs mt-1 text-muted-foreground">
                      Create a collection first to add workflows
                    </p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {filteredCollections.map((collection) => (
                      <div key={collection.id}>
                        <div className="text-xs font-medium text-muted-foreground mb-2 px-1">
                          {collection.name}
                        </div>
                        <WorkflowManager
                          collectionId={collection.id}
                          onSelectWorkflow={(workflow) => setSelectedWorkflow(workflow)}
                          onRunWorkflow={(workflow) => setRunningWorkflow(workflow)}
                        />
                      </div>
                    ))}
                  </div>
                )}
              </TabsContent>
            </Tabs>

            {/* Workflow Builder Dialog */}
            {selectedWorkflow && (
              <WorkflowBuilder
                workflow={selectedWorkflow}
                open={!!selectedWorkflow}
                onOpenChange={(open) => !open && setSelectedWorkflow(null)}
                onRun={() => {
                  setRunningWorkflow(selectedWorkflow);
                  setSelectedWorkflow(null);
                }}
              />
            )}

            {/* Workflow Executor Dialog */}
            {runningWorkflow && (
              <WorkflowExecutor
                workflow={runningWorkflow}
                open={!!runningWorkflow}
                onOpenChange={(open) => !open && setRunningWorkflow(null)}
              />
            )}
          </>
        )}
      </aside>
    </TooltipProvider>
  );
}

export default withErrorBoundary(Sidebar);
