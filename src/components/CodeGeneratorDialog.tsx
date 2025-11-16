'use client';

import { useState, useMemo } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Copy, Check } from 'lucide-react';
import { codeGenerators, CodeGeneratorType } from '@/lib/codeGenerators';
import { HttpRequest, RequestSettings } from '@/types';
import { useEnvironmentStore } from '@/store/useEnvironmentStore';
import { useSettingsStore } from '@/store/useSettingsStore';

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
  const [activeLanguage, setActiveLanguage] = useState<CodeGeneratorType>('curl');
  const [copied, setCopied] = useState(false);
  const { resolveVariables } = useEnvironmentStore();
  const { settings: globalSettings } = useSettingsStore();

  const generatedCode = useMemo(() => {
    // Resolve environment variables
    const resolvedUrl = resolveVariables(request.url);

    // Build query params
    const resolvedParams: Record<string, string> = {};
    request.params
      .filter((p) => p.enabled && p.key)
      .forEach((p) => {
        resolvedParams[p.key] = resolveVariables(p.value);
      });

    // Build headers
    const resolvedHeaders: Record<string, string> = {};
    request.headers
      .filter((h) => h.enabled && h.key)
      .forEach((h) => {
        resolvedHeaders[h.key] = resolveVariables(h.value);
      });

    // Get effective settings (request-specific or global)
    const effectiveSettings: RequestSettings = request.settings || {
      timeout: globalSettings.defaultTimeout,
      followRedirects: globalSettings.followRedirects,
      maxRedirects: globalSettings.maxRedirects,
      verifySsl: globalSettings.verifySsl,
      proxy: globalSettings.proxy,
    };

    const generator = codeGenerators[activeLanguage];
    return generator.generate({
      request,
      resolvedUrl,
      resolvedHeaders,
      resolvedParams,
      settings: effectiveSettings,
    });
  }, [request, activeLanguage, resolveVariables, globalSettings]);

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
          onValueChange={(v) => setActiveLanguage(v as CodeGeneratorType)}
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
            <div className="absolute top-2 right-2 z-10">
              <Button
                variant="outline"
                size="sm"
                onClick={handleCopy}
                className="gap-2"
              >
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
