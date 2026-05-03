import { useState, useEffect } from 'react';
import { withErrorBoundary } from '@/components/shared/ErrorBoundary';
import RequestLine from '@/features/http/components/RequestLine';
import CodeGeneratorDialog from '@/features/http/components/CodeGeneratorDialog';
import { RequestBuilderTabs } from './RequestBuilderTabs';
import { useHttpRequestPage } from '@/features/http/hooks/useHttpRequestPage';

const TAB_KEYS: Record<string, string> = {
  '1': 'params', '2': 'headers', '3': 'body',
  '4': 'auth', '5': 'scripts', '6': 'settings',
};

function RequestBuilder() {
  const { httpRequest, isLoading, globalSettings, handlers, counts } = useHttpRequestPage();
  const { sendRequest } = handlers;
  const [activeTab, setActiveTab] = useState('params');
  const [codeGenOpen, setCodeGenOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.altKey && !e.metaKey && !e.ctrlKey) {
        const tab = TAB_KEYS[e.key];
        if (tab) { e.preventDefault(); setActiveTab(tab); }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        sendRequest();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [sendRequest]);

  if (!httpRequest) return null;

  return (
    <div className="flex-1 flex flex-col border-b border-border bg-background relative z-30">
      <RequestLine
        method={httpRequest.method}
        url={httpRequest.url}
        isLoading={isLoading}
        onMethodChange={handlers.changeMethod}
        onUrlChange={handlers.changeUrl}
        onSend={handlers.sendRequest}
        onOpenCodeGen={() => setCodeGenOpen(true)}
      />
      <CodeGeneratorDialog open={codeGenOpen} onOpenChange={setCodeGenOpen} request={httpRequest} />
      <RequestBuilderTabs
        request={httpRequest}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        globalSettings={globalSettings}
        counts={counts}
        handlers={handlers}
      />
    </div>
  );
}

export default withErrorBoundary(RequestBuilder);
