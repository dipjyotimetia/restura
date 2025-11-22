'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Plus, Trash2, ListPlus } from 'lucide-react';
import { KeyValue } from '@/types';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Stagger, StaggerItem } from '@/components/ui/motion';

interface KeyValueEditorProps {
  items: KeyValue[];
  onAdd: () => void;
  onUpdate: (id: string, updates: Partial<KeyValue>) => void;
  onDelete: (id: string) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  addButtonText?: string;
  itemType?: string;
}

export default function KeyValueEditor({
  items,
  onAdd,
  onUpdate,
  onDelete,
  keyPlaceholder = 'Key',
  valuePlaceholder = 'Value',
  addButtonText = 'Add Item',
  itemType = 'item',
}: KeyValueEditorProps) {
  return (
    <TooltipProvider delayDuration={300}>
      <div className="space-y-3">
        {items.length === 0 && (
          <div className="text-center py-10 px-4">
            <div className="mx-auto mb-4 h-12 w-12 rounded-xl bg-gradient-to-br from-slate-100 to-slate-200 dark:from-slate-800 dark:to-slate-700 flex items-center justify-center shadow-sm">
              <ListPlus className="h-6 w-6 text-slate-500 dark:text-slate-400" />
            </div>
            <p className="text-sm font-medium text-foreground mb-1">No {itemType}s added yet</p>
            <p className="text-xs text-muted-foreground">Click the button below to add your first {itemType}</p>
          </div>
        )}
        <Stagger show={items.length > 0}>
        {items.map((item) => (
          <StaggerItem
            key={item.id}
            className="flex items-center gap-3 group p-2 rounded-lg hover:bg-accent transition-colors"
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <div>
                  <Switch
                    checked={item.enabled}
                    onCheckedChange={(checked) => onUpdate(item.id, { enabled: checked })}
                    className="data-[state=checked]:bg-slate-blue-600"
                    aria-label={item.enabled ? `Disable ${itemType}` : `Enable ${itemType}`}
                  />
                </div>
              </TooltipTrigger>
              <TooltipContent>
                <p>{item.enabled ? `Disable ${itemType}` : `Enable ${itemType}`}</p>
              </TooltipContent>
            </Tooltip>
            <Input
              value={item.key}
              onChange={(e) => onUpdate(item.id, { key: e.target.value })}
              placeholder={keyPlaceholder}
              className="flex-1 bg-background border-border focus:border-slate-blue-500/40 transition-colors"
              aria-label={`${itemType} key`}
            />
            <Input
              value={item.value}
              onChange={(e) => onUpdate(item.id, { value: e.target.value })}
              placeholder={valuePlaceholder}
              className="flex-1 bg-background border-border focus:border-slate-blue-500/40 transition-colors"
              aria-label={`${itemType} value`}
            />
            <AlertDialog>
              <Tooltip>
                <TooltipTrigger asChild>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="opacity-0 group-hover:opacity-100 transition-opacity text-destructive hover:text-destructive hover:bg-destructive/10"
                      aria-label={`Delete ${itemType}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </AlertDialogTrigger>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Delete {itemType}</p>
                </TooltipContent>
              </Tooltip>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete {itemType.charAt(0).toUpperCase() + itemType.slice(1)}</AlertDialogTitle>
                  <AlertDialogDescription>
                    Are you sure you want to delete this {itemType}? This action cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => onDelete(item.id)}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </StaggerItem>
        ))}
        </Stagger>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              onClick={onAdd}
              variant="outline"
              size="sm"
              className="border-border hover:border-slate-blue-500/50 hover:bg-slate-blue-50/50 dark:hover:bg-slate-blue-950/30 hover:text-slate-blue-700 dark:hover:text-slate-blue-300 transition-all duration-200 shadow-sm hover:shadow"
            >
              <Plus className="mr-2 h-4 w-4" />
              {addButtonText}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Add new {itemType}</p>
          </TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  );
}
