'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Progress } from '@/components/ui/progress';
import { useCollectionStore } from '@/store/useCollectionStore';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { CollectionItem, HttpRequest, Response as ApiResponse } from '@/types';
import { Play, StopCircle, CheckCircle2, XCircle, AlertCircle, Clock } from 'lucide-react';
import { executeRequest } from '@/lib/requestExecutor';
import { toast } from 'sonner';

interface RunnerResult {
  itemId: string;
  itemName: string;
  status: 'pending' | 'running' | 'success' | 'failed' | 'skipped';
  response?: ApiResponse;
  duration?: number;
  error?: string;
}

export default function CollectionRunner() {
  const { collections } = useCollectionStore();
  const { environments, activeEnvironmentId } = useEnvironmentStore();
  const { settings: globalSettings } = useSettingsStore();

  const [isOpen, setIsOpen] = useState(false);
  const [selectedCollectionId, setSelectedCollectionId] = useState<string>('');
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<string>(activeEnvironmentId || 'none');
  const [isRunning, setIsRunning] = useState(false);
  const [results, setResults] = useState<RunnerResult[]>([]);
  const [currentStep, setCurrentStep] = useState(0);
  const [delay, setDelay] = useState(0);
  const [stopOnError, setStopOnError] = useState(false);

  // Flatten collection items to a list of requests
  const flattenItems = (items: CollectionItem[]): CollectionItem[] => {
    let flat: CollectionItem[] = [];
    items.forEach(item => {
      if (item.type === 'request') {
        flat.push(item);
      } else if (item.items) {
        flat = [...flat, ...flattenItems(item.items)];
      }
    });
    return flat;
  };

  const selectedCollection = collections.find(c => c.id === selectedCollectionId);
  const requestItems = selectedCollection ? flattenItems(selectedCollection.items) : [];

  useEffect(() => {
    if (selectedCollection) {
      setResults(requestItems.map(item => ({
        itemId: item.id,
        itemName: item.name,
        status: 'pending'
      })));
    }
  }, [selectedCollectionId]);

  const handleRun = async () => {
    if (!selectedCollection || requestItems.length === 0) return;

    setIsRunning(true);
    setCurrentStep(0);
    
    // Initialize environment variables
    const env = environments.find(e => e.id === selectedEnvironmentId);
    const envVars: Record<string, string> = {};
    if (env) {
      env.variables.filter(v => v.enabled).forEach(v => {
        envVars[v.key] = v.value;
      });
    }

    // Reset results
    const newResults = requestItems.map(item => ({
      itemId: item.id,
      itemName: item.name,
      status: 'pending' as const
    }));
    setResults(newResults);

    for (let i = 0; i < requestItems.length; i++) {
      if (!isOpen) break; // Stop if dialog closed

      const item = requestItems[i];
      if (!item) continue;
      setCurrentStep(i + 1);

      // Update status to running
      setResults(prev => prev.map((r, idx) => idx === i ? { ...r, status: 'running' } : r));

      try {
        // Delay if configured
        if (delay > 0 && i > 0) {
          await new Promise(resolve => setTimeout(resolve, delay));
        }

        if (!item.request || item.request.type !== 'http') {
          setResults(prev => prev.map((r, idx) => idx === i ? { ...r, status: 'skipped' } : r));
          continue;
        }

        const result = await executeRequest({
          request: item.request as HttpRequest,
          envVars,
          globalSettings,
          resolveVariables: (text) => {
            // Custom resolver using current runner envVars
            let res = text;
            Object.entries(envVars).forEach(([key, value]) => {
              res = res.replace(new RegExp(`{{${key}}}`, 'g'), value);
            });
            return res;
          }
        });

        const isSuccess = result.response.status >= 200 && result.response.status < 300;
        
        setResults(prev => prev.map((r, idx) => idx === i ? { 
          ...r, 
          status: isSuccess ? 'success' : 'failed',
          response: result.response,
          duration: result.response.time
        } : r));

        if (!isSuccess && stopOnError) {
          break;
        }

      } catch (error: unknown) {
        setResults(prev => prev.map((r, idx) => idx === i ? { 
          ...r, 
          status: 'failed',
          error: error instanceof Error ? error.message : String(error)
        } : r));

        if (stopOnError) break;
      }
    }

    setIsRunning(false);
    toast.success('Collection run completed');
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'pending': return <Clock className="h-4 w-4 text-muted-foreground" />;
      case 'running': return <div className="h-4 w-4 rounded-full border-2 border-primary border-t-transparent animate-spin" />;
      case 'success': return <CheckCircle2 className="h-4 w-4 text-green-500" />;
      case 'failed': return <XCircle className="h-4 w-4 text-red-500" />;
      case 'skipped': return <AlertCircle className="h-4 w-4 text-yellow-500" />;
      default: return null;
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Play className="mr-2 h-4 w-4" />
          Runner
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Collection Runner</DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-3 gap-6 flex-1 overflow-hidden">
          {/* Configuration Sidebar */}
          <div className="col-span-1 border-r pr-6 space-y-6">
            <div className="space-y-2">
              <label className="text-sm font-medium">Collection</label>
              <Select value={selectedCollectionId} onValueChange={setSelectedCollectionId} disabled={isRunning}>
                <SelectTrigger>
                  <SelectValue placeholder="Select collection" />
                </SelectTrigger>
                <SelectContent>
                  {collections.map(col => (
                    <SelectItem key={col.id} value={col.id}>{col.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Environment</label>
              <Select value={selectedEnvironmentId} onValueChange={setSelectedEnvironmentId} disabled={isRunning}>
                <SelectTrigger>
                  <SelectValue placeholder="Select environment" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No Environment</SelectItem>
                  {environments.map(env => (
                    <SelectItem key={env.id} value={env.id}>{env.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Delay (ms)</label>
              <input 
                type="number" 
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                value={delay}
                onChange={(e) => setDelay(parseInt(e.target.value) || 0)}
                disabled={isRunning}
                min={0}
              />
            </div>

            <div className="flex items-center space-x-2">
              <Checkbox 
                id="stopOnError" 
                checked={stopOnError} 
                onCheckedChange={(checked: boolean | 'indeterminate') => setStopOnError(!!checked)}
                disabled={isRunning}
              />
              <label htmlFor="stopOnError" className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
                Stop on error
              </label>
            </div>

            <Button 
              className="w-full" 
              onClick={handleRun} 
              disabled={!selectedCollection || requestItems.length === 0 || isRunning}
            >
              {isRunning ? (
                <>
                  <StopCircle className="mr-2 h-4 w-4" /> Stop Run
                </>
              ) : (
                <>
                  <Play className="mr-2 h-4 w-4" /> Run Collection
                </>
              )}
            </Button>
          </div>

          {/* Results Area */}
          <div className="col-span-2 flex flex-col overflow-hidden">
            <div className="mb-4 space-y-2">
              <div className="flex justify-between text-sm">
                <span>Progress</span>
                <span>{currentStep} / {requestItems.length}</span>
              </div>
              <Progress value={(currentStep / Math.max(requestItems.length, 1)) * 100} />
            </div>

            <div className="flex-1 border rounded-md overflow-hidden">
              <div className="bg-muted px-4 py-2 text-sm font-medium grid grid-cols-12 gap-2">
                <div className="col-span-6">Request</div>
                <div className="col-span-2">Status</div>
                <div className="col-span-2">Time</div>
                <div className="col-span-2">Code</div>
              </div>
              <ScrollArea className="h-full">
                <div className="divide-y">
                  {results.map((result) => (
                    <div key={result.itemId} className="px-4 py-2 text-sm grid grid-cols-12 gap-2 items-center hover:bg-muted/50">
                      <div className="col-span-6 truncate font-medium">{result.itemName}</div>
                      <div className="col-span-2 flex items-center gap-2">
                        {getStatusIcon(result.status)}
                        <span className="capitalize text-xs text-muted-foreground">{result.status}</span>
                      </div>
                      <div className="col-span-2 text-xs text-muted-foreground">
                        {result.duration ? `${result.duration}ms` : '-'}
                      </div>
                      <div className="col-span-2">
                        {result.response ? (
                          <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${
                            result.response.status >= 200 && result.response.status < 300 
                              ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' 
                              : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                          }`}>
                            {result.response.status}
                          </span>
                        ) : '-'}
                      </div>
                    </div>
                  ))}
                  {results.length === 0 && (
                    <div className="p-8 text-center text-muted-foreground">
                      Select a collection to start running requests
                    </div>
                  )}
                </div>
              </ScrollArea>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
