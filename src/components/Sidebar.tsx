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
import { useCollectionStore } from '@/store/useCollectionStore';
import { useHistoryStore } from '@/store/useHistoryStore';
import { useRequestStore } from '@/store/useRequestStore';
import { FolderPlus, History, Star, X, MoreVertical, Download, Trash2, Search, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { exportToPostman, exportToInsomnia, downloadJSON } from '@/lib/exporters';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { cn } from '@/lib/utils';

// Method color mapping for badges - more refined colors
const methodColors: Record<string, string> = {
  GET: 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800',
  POST: 'bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-800',
  PUT: 'bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-400 border border-blue-200 dark:border-blue-800',
  DELETE: 'bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-400 border border-red-200 dark:border-red-800',
  PATCH: 'bg-slate-blue-50 dark:bg-slate-blue-950/30 text-slate-blue-700 dark:text-slate-blue-400 border border-slate-blue-200 dark:border-slate-blue-800',
  OPTIONS: 'bg-slate-50 dark:bg-slate-900 text-slate-700 dark:text-slate-400 border border-slate-200 dark:border-slate-700',
  HEAD: 'bg-slate-50 dark:bg-slate-900 text-slate-700 dark:text-slate-400 border border-slate-200 dark:border-slate-700',
};

interface SidebarProps {
  onClose: () => void;
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;
}

export default function Sidebar({ onClose, isCollapsed = false, onToggleCollapse }: SidebarProps) {
  const { collections, createNewCollection, addCollection, deleteCollection } = useCollectionStore();
  const { history, favorites, toggleFavorite } = useHistoryStore();
  const { setCurrentRequest } = useRequestStore();
  const [activeTab, setActiveTab] = useState('collections');
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [collectionToDelete, setCollectionToDelete] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [methodFilter, setMethodFilter] = useState<string | null>(null);

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
    let filtered = history;

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
  }, [history, searchQuery, methodFilter]);

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
      const item = history.find((h) => h.id === itemId);
      if (item) {
        setCurrentRequest(item.request);
      }
    },
    [history, setCurrentRequest]
  );

  return (
    <TooltipProvider delayDuration={300}>
      <aside
        className={cn(
          "border-r border-slate-200/60 dark:border-slate-700/50 bg-white/60 dark:bg-slate-900/55 backdrop-blur-xl flex flex-col shadow-elevation-2 relative z-40 transition-all duration-300 ease-out noise-texture",
          isCollapsed ? "w-16" : "w-72"
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-3 border-b border-slate-200/60 dark:border-slate-700/40 bg-slate-50/50 dark:bg-slate-800/50">
          {!isCollapsed && (
            <div className="flex items-center gap-2">
              <div className="h-1.5 w-1.5 rounded-full bg-linear-to-r from-slate-blue-500 to-indigo-500 animate-glow-pulse" />
              <h2 className="font-semibold text-sm tracking-tight text-slate-700 dark:text-slate-200">Workspace</h2>
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
                  <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close sidebar">
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
                  className="h-10 w-10"
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
                  className="h-10 w-10"
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
                  variant="ghost"
                  size="icon"
                  onClick={handleNewCollection}
                  className="h-10 w-10 mt-auto"
                >
                  <FolderPlus className="h-4 w-4 text-slate-blue-600 dark:text-slate-blue-400" />
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
            <div className="p-3 border-b border-slate-200/60 dark:border-slate-700/40">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
                <Input
                  placeholder="Search..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-8 h-8 text-xs bg-slate-50 dark:bg-slate-800/50 border-slate-200 dark:border-slate-700 focus:border-slate-blue-300 dark:focus:border-slate-blue-700"
                />
                {searchQuery && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="absolute right-1 top-1/2 -translate-y-1/2 h-8 w-8"
                    onClick={() => setSearchQuery('')}
                    aria-label="Clear search"
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            </div>

            <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col">
              <TabsList className="w-full rounded-none border-b border-slate-200/60 dark:border-slate-700/40 bg-transparent p-0 h-10">
                <TabsTrigger
                  value="collections"
                  className="flex-1 rounded-none h-10 text-xs font-medium data-[state=active]:border-b-2 data-[state=active]:border-slate-blue-500 data-[state=active]:bg-slate-blue-50/50 dark:data-[state=active]:bg-slate-blue-950/20 data-[state=active]:text-slate-blue-700 dark:data-[state=active]:text-slate-blue-300 transition-all"
                >
                  Collections
                  {filteredCollections.length > 0 && (
                    <span className="ml-1.5 text-xs bg-slate-blue-100 dark:bg-slate-blue-900/40 text-slate-blue-700 dark:text-slate-blue-300 px-1.5 py-0.5 rounded-full tabular-nums font-medium">
                      {filteredCollections.length}
                    </span>
                  )}
                </TabsTrigger>
                <TabsTrigger
                  value="history"
                  className="flex-1 rounded-none h-10 text-xs font-medium data-[state=active]:border-b-2 data-[state=active]:border-slate-blue-500 data-[state=active]:bg-slate-blue-50/50 dark:data-[state=active]:bg-slate-blue-950/20 data-[state=active]:text-slate-blue-700 dark:data-[state=active]:text-slate-blue-300 transition-all"
                >
                  History
                  {filteredHistory.length > 0 && (
                    <span className="ml-1.5 text-xs bg-slate-blue-100 dark:bg-slate-blue-900/40 text-slate-blue-700 dark:text-slate-blue-300 px-1.5 py-0.5 rounded-full tabular-nums font-medium">
                      {filteredHistory.length}
                    </span>
                  )}
                </TabsTrigger>
              </TabsList>

              <TabsContent value="collections" className="flex-1 overflow-auto p-3 mt-0">
                <div className="flex flex-col gap-2">
                  <Button
                    onClick={handleNewCollection}
                    variant="outline"
                    size="sm"
                    className="w-full justify-start h-8 text-xs"
                  >
                    <FolderPlus className="mr-2 h-3.5 w-3.5 text-slate-blue-600 dark:text-slate-blue-400" />
                    New Collection
                  </Button>

                  {filteredCollections.length === 0 ? (
                    <div className="text-center text-xs text-slate-500 dark:text-slate-400 py-10 px-3">
                      <FolderPlus className="mx-auto h-10 w-10 mb-2 opacity-20" />
                      <p className="font-medium">
                        {searchQuery ? 'No collections found' : 'No collections yet'}
                      </p>
                      <p className="text-xs mt-1 text-slate-400 dark:text-slate-500">
                        {searchQuery ? 'Try a different search term' : 'Create one to organize your requests'}
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      {filteredCollections.map((collection) => (
                        <div
                          key={collection.id}
                          className="group p-2.5 rounded-lg bg-slate-50/50 dark:bg-slate-800/30 border border-slate-200/60 dark:border-slate-700/40 hover:border-slate-blue-300 dark:hover:border-slate-blue-700 hover:bg-slate-blue-50/50 dark:hover:bg-slate-blue-950/20 cursor-pointer flex items-center justify-between transition-all shadow-sm hover:shadow-elevation-1"
                        >
                          <div className="flex-1 flex items-center gap-2 min-w-0">
                            <FolderPlus className="h-3.5 w-3.5 text-slate-blue-600 dark:text-slate-blue-400 shrink-0" />
                            <div className="min-w-0">
                              <span className="text-xs font-medium block truncate">{collection.name}</span>
                              <span className="text-xs text-slate-500 dark:text-slate-400">
                                {collection.items.length} {collection.items.length === 1 ? 'item' : 'items'}
                              </span>
                            </div>
                          </div>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 opacity-0 group-hover:opacity-100 shrink-0"
                                onClick={(e) => e.stopPropagation()}
                                aria-label="Collection options"
                              >
                                <MoreVertical className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="bg-white/95 dark:bg-slate-900/95 backdrop-blur-md border-slate-200 dark:border-slate-700">
                              <DropdownMenuSub>
                                <DropdownMenuSubTrigger className="text-xs">
                                  <Download className="mr-2 h-3.5 w-3.5" />
                                  Export
                                </DropdownMenuSubTrigger>
                                <DropdownMenuSubContent className="bg-white/95 dark:bg-slate-900/95 backdrop-blur-md border-slate-200 dark:border-slate-700">
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
                        </div>
                      ))}
                    </div>
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
                {history.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mb-3">
                    <Button
                      variant={methodFilter === null ? 'secondary' : 'ghost'}
                      size="sm"
                      className="h-7 text-xs px-2.5"
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
                          'h-7 text-xs font-mono px-2.5',
                          methodFilter === method && methodColors[method]
                        )}
                        onClick={() => setMethodFilter(methodFilter === method ? null : method)}
                      >
                        {method}
                      </Button>
                    ))}
                  </div>
                )}

                {filteredHistory.length === 0 ? (
                  <div className="text-center text-xs text-slate-500 dark:text-slate-400 py-10 px-3">
                    <History className="mx-auto h-10 w-10 mb-2 opacity-20" />
                    <p className="font-medium">
                      {searchQuery || methodFilter ? 'No matching requests' : 'No history yet'}
                    </p>
                    <p className="text-xs mt-1 text-slate-400 dark:text-slate-500">
                      {searchQuery || methodFilter
                        ? 'Try adjusting your filters'
                        : 'Send a request to see it here'}
                    </p>
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {filteredHistory.slice(0, 50).map((item) => (
                      <div
                        key={item.id}
                        className="group p-2.5 rounded-lg bg-slate-50/50 dark:bg-slate-800/30 border border-slate-200/60 dark:border-slate-700/40 hover:border-slate-blue-300 dark:hover:border-slate-blue-700 hover:bg-slate-blue-50/50 dark:hover:bg-slate-blue-950/20 cursor-pointer transition-all shadow-sm hover:shadow-elevation-1"
                        onClick={() => handleLoadHistoryItem(item.id)}
                      >
                        <div className="flex items-center gap-1.5 mb-1.5">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleFavorite(item.id);
                            }}
                            aria-label={favorites.includes(item.id) ? 'Remove from favorites' : 'Add to favorites'}
                          >
                            <Star
                              className={cn(
                                "h-4 w-4 transition-all",
                                favorites.includes(item.id)
                                  ? 'text-amber-500 fill-amber-500 scale-110'
                                  : 'text-slate-400 group-hover:text-amber-500'
                              )}
                            />
                          </Button>
                          <span
                            className={cn(
                              'text-xs font-mono font-semibold px-1.5 py-0.5 rounded',
                              item.request.type === 'http'
                                ? methodColors[item.request.method] || 'bg-slate-blue-50 dark:bg-slate-blue-950/30 text-slate-blue-700 dark:text-slate-blue-400'
                                : 'bg-slate-blue-50 dark:bg-slate-blue-950/30 text-slate-blue-700 dark:text-slate-blue-400'
                            )}
                          >
                            {item.request.type === 'http' ? item.request.method : 'gRPC'}
                          </span>
                          {item.response && (
                            <span
                              className={cn(
                                'text-xs font-mono font-semibold px-1.5 py-0.5 rounded tabular-nums',
                                item.response.status >= 200 && item.response.status < 300
                                  ? 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400'
                                  : item.response.status >= 400
                                  ? 'bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-400'
                                  : 'bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400'
                              )}
                            >
                              {item.response.status}
                            </span>
                          )}
                        </div>
                        <p className="text-xs font-medium truncate pl-6 mb-1">
                          {item.request.type === 'http' ? item.request.url : item.request.service}
                        </p>
                        <span className="text-xs text-slate-500 dark:text-slate-400 pl-6 flex items-center gap-1">
                          <History className="h-3 w-3" />
                          {new Date(item.timestamp).toLocaleString()}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </TabsContent>
            </Tabs>
          </>
        )}
      </aside>
    </TooltipProvider>
  );
}
