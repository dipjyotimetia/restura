import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Settings } from 'lucide-react';
import type { HttpRequest, AppSettings } from '@/types';
import KeyValueEditor from '@/components/shared/KeyValueEditor';
import RequestBodyEditor from '@/features/http/components/RequestBodyEditor';
import AuthConfiguration from '@/features/auth/components/AuthConfig';
import ScriptsEditor from '@/features/scripts/components/ScriptsEditor';
import RequestSettingsEditor from '@/features/http/components/RequestSettingsEditor';
import type { useHttpRequestPage } from '@/features/http/hooks/useHttpRequestPage';

type Handlers = ReturnType<typeof useHttpRequestPage>['handlers'];

interface RequestBuilderTabsProps {
  request: HttpRequest;
  activeTab: string;
  onTabChange: (tab: string) => void;
  globalSettings: AppSettings;
  counts: { activeParams: number; activeHeaders: number };
  handlers: Handlers;
}

export function RequestBuilderTabs({
  request,
  activeTab,
  onTabChange,
  globalSettings,
  counts,
  handlers,
}: RequestBuilderTabsProps) {
  return (
    <Tabs value={activeTab} onValueChange={onTabChange} className="flex-1 flex flex-col overflow-hidden">
      <div className="px-3">
        <TabsList className="w-full justify-start">
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <TabsTrigger value="params" className="flex-1 sm:flex-none text-[10px] lg:text-xs px-2 lg:px-3">
                    Params
                    {counts.activeParams > 0 && (
                      <span className="ml-1.5 inline-flex items-center justify-center h-4 min-w-4 px-1 text-[10px] font-bold rounded-full bg-primary/10 text-primary tabular-nums">
                        {counts.activeParams}
                      </span>
                    )}
                  </TabsTrigger>
                </span>
              </TooltipTrigger>
              <TooltipContent><p>Query Parameters (⌥1)</p></TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <TabsTrigger value="headers" className="flex-1 sm:flex-none text-[10px] lg:text-xs px-2 lg:px-3">
                    Headers
                    {counts.activeHeaders > 0 && (
                      <span className="ml-1.5 inline-flex items-center justify-center h-4 min-w-4 px-1 text-[10px] font-bold rounded-full bg-primary/10 text-primary tabular-nums">
                        {counts.activeHeaders}
                      </span>
                    )}
                  </TabsTrigger>
                </span>
              </TooltipTrigger>
              <TooltipContent><p>Request Headers (⌥2)</p></TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <TabsTrigger value="body" className="flex-1 sm:flex-none text-[10px] lg:text-xs px-2 lg:px-3">
                    Body
                    {request.body.type !== 'none' && request.body.raw && (
                      <span className="ml-2 h-1.5 w-1.5 rounded-full bg-emerald-500 ring-2 ring-emerald-500/20" />
                    )}
                  </TabsTrigger>
                </span>
              </TooltipTrigger>
              <TooltipContent><p>Request Body (⌥3)</p></TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <TabsTrigger value="auth" className="flex-1 sm:flex-none text-[10px] lg:text-xs px-2 lg:px-3">
                    Auth
                    {request.auth.type !== 'none' && (
                      <span className="ml-2 h-1.5 w-1.5 rounded-full bg-emerald-500 ring-2 ring-emerald-500/20" />
                    )}
                  </TabsTrigger>
                </span>
              </TooltipTrigger>
              <TooltipContent><p>Authentication (⌥4)</p></TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <TabsTrigger value="scripts" className="flex-1 sm:flex-none text-[10px] lg:text-xs px-2 lg:px-3">
                    Scripts
                    {(request.preRequestScript || request.testScript) && (
                      <span className="ml-2 h-1.5 w-1.5 rounded-full bg-amber-500 ring-2 ring-amber-500/20" />
                    )}
                  </TabsTrigger>
                </span>
              </TooltipTrigger>
              <TooltipContent><p>Pre-request & Test Scripts (⌥5)</p></TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <TabsTrigger value="settings" className="flex-1 sm:flex-none text-[10px] lg:text-xs px-2 lg:px-3">
                    <Settings className="h-3 w-3 lg:h-3.5 lg:w-3.5 mr-1 lg:mr-1.5 opacity-70" />
                    Settings
                    {request.settings && <span className="ml-2 h-1.5 w-1.5 rounded-full bg-blue-500 ring-2 ring-blue-500/20" />}
                  </TabsTrigger>
                </span>
              </TooltipTrigger>
              <TooltipContent><p>Request Settings (⌥6)</p></TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </TabsList>
      </div>

      <TabsContent value="params" className="flex-1 overflow-auto p-4">
        <KeyValueEditor
          items={request.params}
          onAdd={handlers.addParam}
          onUpdate={handlers.updateParam}
          onDelete={handlers.removeParam}
          keyPlaceholder="Parameter name"
          valuePlaceholder="Parameter value"
          addButtonText="Add Param"
          itemType="parameter"
        />
      </TabsContent>

      <TabsContent value="headers" className="flex-1 overflow-auto p-4">
        <KeyValueEditor
          items={request.headers}
          onAdd={handlers.addHeader}
          onUpdate={handlers.updateHeader}
          onDelete={handlers.removeHeader}
          keyPlaceholder="Header name"
          valuePlaceholder="Header value"
          addButtonText="Add Header"
          itemType="header"
        />
      </TabsContent>

      <TabsContent value="body" className="flex-1 overflow-auto p-4">
        <RequestBodyEditor
          body={request.body}
          onBodyTypeChange={handlers.changeBodyType}
          onBodyContentChange={handlers.changeBodyContent}
          url={request.url}
        />
      </TabsContent>

      <TabsContent value="auth" className="flex-1 overflow-auto p-4">
        <AuthConfiguration auth={request.auth} onChange={handlers.changeAuth} />
      </TabsContent>

      <TabsContent value="scripts" className="flex-1 overflow-auto p-4">
        <ScriptsEditor
          preRequestScript={request.preRequestScript || ''}
          testScript={request.testScript || ''}
          onPreRequestScriptChange={handlers.changePreRequestScript}
          onTestScriptChange={handlers.changeTestScript}
        />
      </TabsContent>

      <TabsContent value="settings" className="flex-1 overflow-auto p-4">
        <RequestSettingsEditor
          settings={request.settings}
          globalSettings={globalSettings}
          onSettingsChange={handlers.changeSettings}
          onToggleOverride={handlers.toggleSettingsOverride}
          onProxyOverrideChange={handlers.changeProxyOverride}
        />
      </TabsContent>
    </Tabs>
  );
}
