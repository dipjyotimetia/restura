import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import type { KeyValue } from '@/types';
import { Plus, Trash2, Edit, Globe, Check } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { withErrorBoundary } from '@/components/shared/ErrorBoundary';
import KeyValueEditor from '@/components/shared/KeyValueEditor';
import { cn } from '@/lib/shared/utils';

interface EnvironmentManagerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function EnvironmentManager({ open, onOpenChange }: EnvironmentManagerProps) {
  const {
    environments,
    activeEnvironmentId,
    addEnvironment,
    updateEnvironment,
    removeEnvironment,
    setActiveEnvironment,
    addVariable,
    updateVariable,
    removeVariable,
    createNewEnvironment,
  } = useEnvironmentStore();

  const [selectedEnvId, setSelectedEnvId] = useState<string | null>(
    activeEnvironmentId || (environments.length > 0 ? environments[0]?.id ?? null : null)
  );
  const [editingEnvName, setEditingEnvName] = useState(false);
  const [newEnvName, setNewEnvName] = useState('');
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [envToDelete, setEnvToDelete] = useState<string | null>(null);

  const selectedEnv = environments.find((env) => env.id === selectedEnvId);

  const handleCreateEnvironment = () => {
    const name = `Environment ${environments.length + 1}`;
    const newEnv = createNewEnvironment(name);
    addEnvironment(newEnv);
    setSelectedEnvId(newEnv.id);
  };

  const handleDeleteEnvironment = (id: string) => {
    setEnvToDelete(id);
    setDeleteDialogOpen(true);
  };

  const confirmDeleteEnvironment = () => {
    if (envToDelete) {
      removeEnvironment(envToDelete);
      if (selectedEnvId === envToDelete) {
        setSelectedEnvId(environments[0]?.id || null);
      }
      setEnvToDelete(null);
    }
    setDeleteDialogOpen(false);
  };

  const handleUpdateEnvName = () => {
    if (selectedEnvId && newEnvName.trim()) {
      updateEnvironment(selectedEnvId, { name: newEnvName.trim() });
      setEditingEnvName(false);
      setNewEnvName('');
    }
  };

  const handleAddVariable = () => {
    if (selectedEnvId) {
      const newVar: KeyValue = { id: uuidv4(), key: '', value: '', enabled: true };
      addVariable(selectedEnvId, newVar);
    }
  };

  const handleUpdateVariable = (varId: string, updates: Partial<KeyValue>) => {
    if (selectedEnvId) {
      updateVariable(selectedEnvId, varId, updates);
    }
  };

  const handleDeleteVariable = (varId: string) => {
    if (selectedEnvId) {
      removeVariable(selectedEnvId, varId);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-mono text-sm tracking-wide">
            <Globe className="h-4 w-4 text-primary" />
            ENVIRONMENTS
          </DialogTitle>
          <DialogDescription className="font-mono text-xs">
            Create and manage environment variables for your API requests
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 flex gap-0 overflow-hidden border border-border rounded-lg">
          {/* Environment list */}
          <div className="w-52 border-r border-border flex flex-col shrink-0">
            <div className="px-3 py-2 border-b border-border flex items-center justify-between">
              <span className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                Environments
              </span>
              <Button onClick={handleCreateEnvironment} size="icon" variant="ghost" className="h-5 w-5">
                <Plus className="h-3 w-3" />
              </Button>
            </div>

            <div className="flex-1 overflow-auto p-1.5 space-y-0.5">
              {environments.map((env) => (
                <div
                  key={env.id}
                  className={cn(
                    'flex items-center justify-between px-2 py-1.5 rounded cursor-pointer group transition-colors',
                    selectedEnvId === env.id
                      ? 'bg-primary/10 text-primary'
                      : 'hover:bg-surface-2 text-muted-foreground hover:text-foreground'
                  )}
                  onClick={() => setSelectedEnvId(env.id)}
                >
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    {activeEnvironmentId === env.id && (
                      <div className="h-1.5 w-1.5 rounded-full bg-primary shrink-0" aria-label="Active environment" />
                    )}
                    <span className="text-xs font-mono truncate">{env.name}</span>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-5 w-5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteEnvironment(env.id);
                    }}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              ))}

              {environments.length === 0 && (
                <div className="text-center py-8 text-xs font-mono text-muted-foreground/50">
                  No environments yet
                </div>
              )}
            </div>

            <div className="p-1.5 border-t border-border">
              <Button onClick={handleCreateEnvironment} variant="outline" size="sm" className="w-full font-mono text-xs">
                <Plus className="mr-2 h-3.5 w-3.5" />
                New Environment
              </Button>
            </div>
          </div>

          {/* Environment details */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {selectedEnv ? (
              <>
                <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border shrink-0">
                  {editingEnvName ? (
                    <div className="flex items-center gap-2 flex-1">
                      <Input
                        value={newEnvName}
                        onChange={(e) => setNewEnvName(e.target.value)}
                        placeholder="Environment name"
                        className="flex-1 h-7 font-mono text-xs"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleUpdateEnvName();
                          if (e.key === 'Escape') { setEditingEnvName(false); setNewEnvName(''); }
                        }}
                        autoFocus
                      />
                      <Button onClick={handleUpdateEnvName} size="sm" className="h-7 font-mono text-xs">Save</Button>
                      <Button
                        onClick={() => { setEditingEnvName(false); setNewEnvName(''); }}
                        size="sm"
                        variant="ghost"
                        className="h-7 font-mono text-xs"
                      >
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <>
                      <span className="text-sm font-mono flex-1">{selectedEnv.name}</span>
                      <Button
                        onClick={() => { setNewEnvName(selectedEnv.name); setEditingEnvName(true); }}
                        size="icon"
                        variant="ghost"
                        className="h-6 w-6"
                      >
                        <Edit className="h-3.5 w-3.5" />
                      </Button>
                    </>
                  )}
                </div>

                <div className="flex-1 overflow-auto p-4 space-y-4">
                  <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
                    Variables
                  </p>
                  <KeyValueEditor
                    items={selectedEnv.variables}
                    onAdd={handleAddVariable}
                    onUpdate={handleUpdateVariable}
                    onDelete={handleDeleteVariable}
                    keyPlaceholder="Variable name"
                    valuePlaceholder="Variable value"
                    addButtonText="Add Variable"
                    itemType="variable"
                  />

                  <div className="mt-4 p-3 bg-surface-2 rounded border border-border">
                    <p className="text-[10px] font-mono uppercase tracking-widest text-muted-foreground mb-2">Usage</p>
                    <p className="text-xs text-muted-foreground font-mono">
                      Use variables with{' '}
                      <code className="bg-surface-3 px-1 py-0.5 rounded text-primary">{'{{variableName}}'}</code>
                    </p>
                    <p className="text-xs text-muted-foreground font-mono mt-1">
                      Example:{' '}
                      <code className="bg-surface-3 px-1 py-0.5 rounded text-muted-foreground">
                        https://{'{{host}}'}/api/{'{{version}}'}
                      </code>
                    </p>
                  </div>
                </div>
              </>
            ) : (
              <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground/50">
                <Globe className="h-6 w-6" />
                <p className="text-xs font-mono">Select or create an environment</p>
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button
            onClick={() => {
              if (selectedEnvId) setActiveEnvironment(selectedEnvId);
              onOpenChange(false);
            }}
            className="font-mono text-xs gap-2"
          >
            <Check className="h-3.5 w-3.5" />
            Set Active & Close
          </Button>
        </DialogFooter>
      </DialogContent>

      <ConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title="Delete Environment"
        description="Are you sure you want to delete this environment? This action cannot be undone and all variables in this environment will be lost."
        confirmText="Delete"
        cancelText="Cancel"
        onConfirm={confirmDeleteEnvironment}
        variant="destructive"
      />
    </Dialog>
  );
}

export default withErrorBoundary(EnvironmentManager);
