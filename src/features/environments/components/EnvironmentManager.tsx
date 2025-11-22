'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { KeyValue } from '@/types';
import { Plus, Trash2, Edit, Globe } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';

interface EnvironmentManagerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export default function EnvironmentManager({ open, onOpenChange }: EnvironmentManagerProps) {
  const {
    environments,
    activeEnvironmentId,
    addEnvironment,
    updateEnvironment,
    deleteEnvironment,
    setActiveEnvironment,
    addVariable,
    updateVariable,
    deleteVariable,
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
      deleteEnvironment(envToDelete);
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
      const newVar: KeyValue = {
        id: uuidv4(),
        key: '',
        value: '',
        enabled: true,
      };
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
      deleteVariable(selectedEnvId, varId);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Globe className="h-5 w-5" />
            Manage Environments
          </DialogTitle>
          <DialogDescription>
            Create and manage environment variables for your API requests
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 flex gap-4 overflow-hidden">
          {/* Environments List */}
          <div className="w-64 border-r pr-4 flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-sm">Environments</h3>
              <Button onClick={handleCreateEnvironment} size="sm" variant="ghost">
                <Plus className="h-4 w-4" />
              </Button>
            </div>

            <div className="flex-1 overflow-auto space-y-1">
              {environments.map((env) => (
                <div
                  key={env.id}
                  className={`flex items-center justify-between p-2 rounded cursor-pointer hover:bg-accent ${
                    selectedEnvId === env.id ? 'bg-accent' : ''
                  }`}
                  onClick={() => setSelectedEnvId(env.id)}
                >
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    {activeEnvironmentId === env.id && (
                      <div className="h-2 w-2 rounded-full bg-green-500" />
                    )}
                    <span className="text-sm truncate">{env.name}</span>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
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
                <div className="text-center py-8 text-sm text-muted-foreground">
                  No environments yet
                </div>
              )}
            </div>

            <Button
              onClick={handleCreateEnvironment}
              variant="outline"
              size="sm"
              className="mt-4 w-full"
            >
              <Plus className="mr-2 h-4 w-4" />
              New Environment
            </Button>
          </div>

          {/* Environment Details */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {selectedEnv ? (
              <>
                <div className="flex items-center gap-2 mb-4">
                  {editingEnvName ? (
                    <div className="flex items-center gap-2 flex-1">
                      <Input
                        value={newEnvName}
                        onChange={(e) => setNewEnvName(e.target.value)}
                        placeholder="Environment name"
                        className="flex-1"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleUpdateEnvName();
                          if (e.key === 'Escape') {
                            setEditingEnvName(false);
                            setNewEnvName('');
                          }
                        }}
                        autoFocus
                      />
                      <Button onClick={handleUpdateEnvName} size="sm">
                        Save
                      </Button>
                      <Button
                        onClick={() => {
                          setEditingEnvName(false);
                          setNewEnvName('');
                        }}
                        size="sm"
                        variant="ghost"
                      >
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <>
                      <h3 className="text-lg font-semibold flex-1">{selectedEnv.name}</h3>
                      <Button
                        onClick={() => {
                          setNewEnvName(selectedEnv.name);
                          setEditingEnvName(true);
                        }}
                        size="sm"
                        variant="ghost"
                      >
                        <Edit className="h-4 w-4" />
                      </Button>
                    </>
                  )}
                </div>

                <Tabs defaultValue="variables" className="flex-1 flex flex-col overflow-hidden">
                  <TabsList>
                    <TabsTrigger value="variables">Variables</TabsTrigger>
                  </TabsList>

                  <TabsContent value="variables" className="flex-1 overflow-auto space-y-2 mt-4">
                    <div className="space-y-2">
                      <div className="grid grid-cols-12 gap-2 text-sm font-semibold text-muted-foreground px-2">
                        <div className="col-span-1"></div>
                        <div className="col-span-4">Key</div>
                        <div className="col-span-6">Value</div>
                        <div className="col-span-1"></div>
                      </div>

                      {selectedEnv.variables.map((variable) => (
                        <div key={variable.id} className="grid grid-cols-12 gap-2 items-center">
                          <div className="col-span-1 flex items-center justify-center">
                            <input
                              type="checkbox"
                              checked={variable.enabled}
                              onChange={(e) =>
                                handleUpdateVariable(variable.id, { enabled: e.target.checked })
                              }
                              className="h-4 w-4"
                            />
                          </div>
                          <div className="col-span-4">
                            <Input
                              value={variable.key}
                              onChange={(e) =>
                                handleUpdateVariable(variable.id, { key: e.target.value })
                              }
                              placeholder="Variable name"
                            />
                          </div>
                          <div className="col-span-6">
                            <Input
                              value={variable.value}
                              onChange={(e) =>
                                handleUpdateVariable(variable.id, { value: e.target.value })
                              }
                              placeholder="Variable value"
                            />
                          </div>
                          <div className="col-span-1 flex items-center justify-center">
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => handleDeleteVariable(variable.id)}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>

                    <Button onClick={handleAddVariable} variant="outline" size="sm" className="mt-4">
                      <Plus className="mr-2 h-4 w-4" />
                      Add Variable
                    </Button>

                    <div className="mt-6 p-4 bg-muted rounded-lg">
                      <h4 className="font-semibold text-sm mb-2">Usage</h4>
                      <p className="text-sm text-muted-foreground">
                        Use variables in your requests with the syntax:{' '}
                        <code className="bg-background px-1 py-0.5 rounded">
                          {'{{variableName}}'}
                        </code>
                      </p>
                      <p className="text-sm text-muted-foreground mt-2">
                        Example: <code className="bg-background px-1 py-0.5 rounded">
                          https://{'{{host}}'}/api/{'{{version}}'}
                        </code>
                      </p>
                    </div>
                  </TabsContent>
                </Tabs>
              </>
            ) : (
              <div className="flex items-center justify-center h-full text-muted-foreground">
                Select an environment or create a new one
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button
            onClick={() => {
              if (selectedEnvId) {
                setActiveEnvironment(selectedEnvId);
              }
              onOpenChange(false);
            }}
          >
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
