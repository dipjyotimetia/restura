'use client';

import { useEffect, useState } from 'react';
import { withErrorBoundary } from '@/components/shared/ErrorBoundary';
import { Floater } from '@/components/ui/spatial';
import UrlBar from '@/features/http/components/UrlBar';
import { useHttpRequestPage } from '@/features/http/hooks/useHttpRequestPage';
import { lazyComponent } from '@/lib/shared/lazyComponent';
import { useUiStore } from '@/store/useUiStore';
import { RequestBuilderTabs } from './RequestBuilderTabs';

const CodeGeneratorDialog = lazyComponent(
  () => import('@/features/http/components/CodeGeneratorDialog')
);
const LoadTestDialog = lazyComponent(
  () => import('@/features/load-testing/components/LoadTestDialog')
);

type SubTabKey = 'params' | 'headers' | 'body' | 'auth' | 'scripts' | 'settings';

const TAB_KEYS: Record<string, SubTabKey> = {
  '1': 'params',
  '2': 'headers',
  '3': 'body',
  '4': 'auth',
  '5': 'scripts',
  '6': 'settings',
};

function RequestBuilder() {
  const { httpRequest, isLoading, globalSettings, handlers, counts } = useHttpRequestPage();
  const { sendRequest } = handlers;
  const [activeTab, setActiveTab] = useState<SubTabKey>('params');
  // Code-gen open state lives in the UI store so the command palette can open
  // it from outside this subtree. Reset on unmount so it can't reopen stale
  // when switching protocols.
  const codeGenOpen = useUiStore((s) => s.codeGenOpen);
  const setCodeGenOpen = useUiStore((s) => s.setCodeGenOpen);
  const loadTestOpen = useUiStore((s) => s.loadTestOpen);
  const setLoadTestOpen = useUiStore((s) => s.setLoadTestOpen);
  useEffect(
    () => () => {
      setCodeGenOpen(false);
      setLoadTestOpen(false);
    },
    [setCodeGenOpen, setLoadTestOpen]
  );

  // Alt+1..6 sub-tab jump
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.altKey && !e.metaKey && !e.ctrlKey) {
        const tab = TAB_KEYS[e.key];
        if (tab) {
          e.preventDefault();
          setActiveTab(tab);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Cmd/Ctrl + Enter send
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
    <div className="flex-1 flex flex-col min-h-0 px-2 pt-2 pb-3 gap-2.5 relative z-30">
      <UrlBar
        method={httpRequest.method}
        url={httpRequest.url}
        isLoading={isLoading}
        onMethodChange={handlers.changeMethod}
        onUrlChange={handlers.changeUrl}
        onSend={handlers.sendRequest}
        onOpenCodeGen={() => setCodeGenOpen(true)}
      />

      {httpRequest.description && (
        <p
          className="px-3 -mt-1 text-sp-11 text-sp-dim whitespace-pre-wrap line-clamp-3"
          title={httpRequest.description}
        >
          {httpRequest.description}
        </p>
      )}

      {codeGenOpen && (
        <CodeGeneratorDialog
          open={codeGenOpen}
          onOpenChange={setCodeGenOpen}
          request={httpRequest}
        />
      )}

      {loadTestOpen && (
        <LoadTestDialog
          open={loadTestOpen}
          onClose={() => setLoadTestOpen(false)}
          request={httpRequest}
        />
      )}

      <Floater
        radius="panel"
        elevation="float"
        className="flex-1 flex flex-col min-h-0 bg-sp-surface overflow-hidden"
      >
        <RequestBuilderTabs
          request={httpRequest}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          globalSettings={globalSettings}
          counts={counts}
          handlers={handlers}
        />
      </Floater>
    </div>
  );
}

export default withErrorBoundary(RequestBuilder);
