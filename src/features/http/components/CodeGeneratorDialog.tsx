'use client';

import { Check, Copy } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { resolveEffectiveSettings } from '@/features/http/lib/effectiveSettings';
import { generateRequestCode } from '@/features/http/lib/requestCode';
import { useVariableDetails } from '@/hooks/useVariableStatus';
import type { CodeGeneratorType } from '@/lib/shared/codeGenerators';
import { codeGenerators } from '@/lib/shared/codeGenerators';
import { useSettingsStore } from '@/store/useSettingsStore';
import type { HttpRequest } from '@/types';

interface CodeGeneratorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  request: HttpRequest;
}

export default function CodeGeneratorDialog({
  open,
  onOpenChange,
  request,
}: CodeGeneratorDialogProps) {
  // Last-used language is remembered in settings (cURL by default).
  const savedLanguage = useSettingsStore((s) => s.settings.codegenLanguage);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const activeLanguage: CodeGeneratorType =
    savedLanguage && Object.hasOwn(codeGenerators, savedLanguage)
      ? (savedLanguage as CodeGeneratorType)
      : 'curl';
  const [maskSecrets, setMaskSecrets] = useState(true);
  const [copied, setCopied] = useState(false);
  const globalSettings = useSettingsStore((s) => s.settings);
  const variables = useVariableDetails();

  const generatedCode = useMemo(
    () =>
      generateRequestCode(request, activeLanguage, {
        variables,
        maskSecrets,
        settings: resolveEffectiveSettings(request.settings, globalSettings),
      }),
    [request, activeLanguage, variables, maskSecrets, globalSettings]
  );

  const handleCopy = async () => {
    await navigator.clipboard.writeText(generatedCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Generate Code</DialogTitle>
          <DialogDescription>
            Export this request as code in various programming languages
          </DialogDescription>
        </DialogHeader>

        <Tabs
          value={activeLanguage}
          onValueChange={(v) => updateSettings({ codegenLanguage: v })}
          className="flex-1 flex flex-col overflow-hidden"
        >
          <TabsList className="grid grid-cols-7 w-full">
            {Object.entries(codeGenerators).map(([key, { name }]) => (
              <TabsTrigger key={key} value={key}>
                {name}
              </TabsTrigger>
            ))}
          </TabsList>

          <div className="flex-1 overflow-hidden mt-4 relative">
            <div className="absolute top-2 right-2 z-10 flex items-center gap-3">
              <label className="flex items-center gap-2 text-sp-12 text-sp-muted">
                <Switch
                  checked={maskSecrets}
                  onCheckedChange={setMaskSecrets}
                  aria-label="Mask secrets"
                />
                Mask secrets
              </label>
              <Button variant="outline" size="sm" onClick={handleCopy} className="gap-2">
                {copied ? (
                  <>
                    <Check className="h-4 w-4" />
                    Copied!
                  </>
                ) : (
                  <>
                    <Copy className="h-4 w-4" />
                    Copy
                  </>
                )}
              </Button>
            </div>

            {Object.keys(codeGenerators).map((lang) => (
              <TabsContent
                key={lang}
                value={lang}
                className="h-full m-0 data-[state=active]:flex flex-col"
              >
                <pre className="flex-1 overflow-auto p-4 bg-muted rounded-lg font-mono text-sm">
                  <code>{generatedCode}</code>
                </pre>
              </TabsContent>
            ))}
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
