'use client';

import { useState } from 'react';
import { VariableExtraction, ExtractionMethod } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Plus, Trash2, TestTube } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { testExtraction } from '../lib/variableExtractor';

interface VariableExtractorConfigProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  extractions: VariableExtraction[];
  onSave: (extractions: VariableExtraction[]) => void;
  testBody?: string;
  testHeaders?: Record<string, string | string[]>;
}

const methodDescriptions: Record<ExtractionMethod, string> = {
  jsonpath: 'Dot notation path (e.g., data.user.id, items[0].name)',
  regex: 'Regular expression with capture group',
  header: 'Response header name',
};

export function VariableExtractorConfig({
  open,
  onOpenChange,
  extractions,
  onSave,
  testBody = '',
  testHeaders = {},
}: VariableExtractorConfigProps) {
  const [items, setItems] = useState<VariableExtraction[]>(extractions);
  const [testResults, setTestResults] = useState<Record<string, { success: boolean; value?: string; error?: string }>>({});

  const handleAdd = () => {
    setItems([
      ...items,
      {
        id: uuidv4(),
        variableName: '',
        extractionMethod: 'jsonpath',
        path: '',
      },
    ]);
  };

  const handleRemove = (id: string) => {
    setItems(items.filter((item) => item.id !== id));
    setTestResults((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const handleUpdate = (id: string, updates: Partial<VariableExtraction>) => {
    setItems(items.map((item) => (item.id === id ? { ...item, ...updates } : item)));
  };

  const handleTest = (extraction: VariableExtraction) => {
    const result = testExtraction(testBody, testHeaders, extraction);
    setTestResults((prev) => ({ ...prev, [extraction.id]: result }));
  };

  const handleSave = () => {
    // Filter out empty entries
    const validItems = items.filter((item) => item.variableName && item.path);
    onSave(validItems);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Configure Variable Extractions</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {items.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              No extractions configured. Click "Add Extraction" to get started.
            </div>
          ) : (
            items.map((item) => (
              <div
                key={item.id}
                className="border rounded-lg p-4 space-y-3"
              >
                <div className="flex items-start gap-4">
                  {/* Variable Name */}
                  <div className="flex-1">
                    <Label className="text-xs">Variable Name</Label>
                    <Input
                      placeholder="e.g., token, userId"
                      value={item.variableName}
                      onChange={(e) =>
                        handleUpdate(item.id, { variableName: e.target.value })
                      }
                      className="mt-1"
                    />
                  </div>

                  {/* Extraction Method */}
                  <div className="w-40">
                    <Label className="text-xs">Method</Label>
                    <Select
                      value={item.extractionMethod}
                      onValueChange={(v: ExtractionMethod) =>
                        handleUpdate(item.id, { extractionMethod: v })
                      }
                    >
                      <SelectTrigger className="mt-1">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="jsonpath">JSONPath</SelectItem>
                        <SelectItem value="regex">Regex</SelectItem>
                        <SelectItem value="header">Header</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Actions */}
                  <div className="flex items-end gap-1 pb-0.5">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => handleTest(item)}
                      disabled={!testBody && item.extractionMethod !== 'header'}
                      title="Test extraction"
                    >
                      <TestTube className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-destructive hover:text-destructive"
                      onClick={() => handleRemove(item.id)}
                      title="Remove"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                {/* Path */}
                <div>
                  <Label className="text-xs">
                    {item.extractionMethod === 'header' ? 'Header Name' : 'Path'}
                  </Label>
                  <Input
                    placeholder={
                      item.extractionMethod === 'jsonpath'
                        ? 'data.user.id'
                        : item.extractionMethod === 'regex'
                          ? '"token":"([^"]+)"'
                          : 'Authorization'
                    }
                    value={item.path}
                    onChange={(e) =>
                      handleUpdate(item.id, { path: e.target.value })
                    }
                    className="mt-1 font-mono text-sm"
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    {methodDescriptions[item.extractionMethod]}
                  </p>
                </div>

                {/* Test Result */}
                {testResults[item.id] && (
                  <div
                    className={`text-sm p-2 rounded ${
                      testResults[item.id]?.success
                        ? 'bg-green-50 dark:bg-green-950 text-green-700 dark:text-green-300'
                        : 'bg-red-50 dark:bg-red-950 text-red-700 dark:text-red-300'
                    }`}
                  >
                    {testResults[item.id]?.success ? (
                      <>
                        <span className="font-medium">Result:</span>{' '}
                        <code className="bg-background px-1 rounded">
                          {testResults[item.id]?.value}
                        </code>
                      </>
                    ) : (
                      <>
                        <span className="font-medium">Error:</span>{' '}
                        {testResults[item.id]?.error}
                      </>
                    )}
                  </div>
                )}
              </div>
            ))
          )}

          <Button variant="outline" onClick={handleAdd} className="w-full">
            <Plus className="h-4 w-4 mr-2" />
            Add Extraction
          </Button>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
