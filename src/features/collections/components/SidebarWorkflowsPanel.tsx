import { ChevronDown, ChevronRight, GitBranch } from 'lucide-react';
import { TabsContent } from '@/components/ui/tabs';
import type { OwsStoredWorkflow } from '@/store/useWorkflowStore';
import type { Collection } from '@/types';
import { SidebarEmptyState } from './SidebarEmptyState';
import { WorkflowManager } from './sidebarLazyDialogs';

interface SidebarWorkflowsPanelProps {
  collections: Collection[];
  collapsedGroups: Set<string>;
  workflowCounts: Record<string, number>;
  onRunWorkflow: (workflow: OwsStoredWorkflow) => void;
  onSelectWorkflow: (workflow: OwsStoredWorkflow) => void;
  onToggleGroup: (collectionId: string) => void;
}

export function SidebarWorkflowsPanel({
  collections,
  collapsedGroups,
  workflowCounts,
  onRunWorkflow,
  onSelectWorkflow,
  onToggleGroup,
}: SidebarWorkflowsPanelProps) {
  return (
    <TabsContent value="workflows" className="flex-1 overflow-auto p-3 mt-0">
      {collections.length === 0 ? (
        <SidebarEmptyState
          icon={GitBranch}
          title="No collections yet"
          hint="Create a collection first to add workflows"
        />
      ) : (
        <div className="space-y-4">
          {collections.map((collection) => {
            const isGroupCollapsed = collapsedGroups.has(collection.id);
            return (
              <div key={collection.id}>
                <button
                  type="button"
                  aria-expanded={!isGroupCollapsed}
                  aria-label={`${isGroupCollapsed ? 'Expand' : 'Collapse'} workflows for ${collection.name}`}
                  onClick={() => onToggleGroup(collection.id)}
                  className="flex w-full items-center gap-1.5 mb-2 px-1 rounded text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  {isGroupCollapsed ? (
                    <ChevronRight className="h-3 w-3 shrink-0 text-sp-muted" aria-hidden="true" />
                  ) : (
                    <ChevronDown className="h-3 w-3 shrink-0 text-sp-muted" aria-hidden="true" />
                  )}
                  <span className="truncate">{collection.name}</span>
                  <span className="ml-auto shrink-0 text-[10px] tabular-nums text-sp-dim">
                    {workflowCounts[collection.id] ?? 0}
                  </span>
                </button>
                {!isGroupCollapsed && (
                  <WorkflowManager
                    collectionId={collection.id}
                    onSelectWorkflow={onSelectWorkflow}
                    onRunWorkflow={onRunWorkflow}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </TabsContent>
  );
}
