import { useEffect, useState } from 'react';
import { useRequestStore } from '@/store/useRequestStore';

/**
 * Shows the AI's current context target: the active tab's protocol mode,
 * method + URL, and the last response status (read from the active tab).
 */
export function ContextPill() {
  const [label, setLabel] = useState<string>('No active tab');

  useEffect(() => {
    const recompute = () => {
      const req = useRequestStore.getState() as unknown as {
        activeTabId: string | null;
        tabs: Array<{
          id: string;
          mode?: string;
          request?: { method?: string; url?: string };
          response?: { status?: number } | null;
        }>;
      };
      if (!req.activeTabId) {
        setLabel('No active tab');
        return;
      }
      const tab = req.tabs.find((t) => t.id === req.activeTabId);
      if (!tab) {
        setLabel('No active tab');
        return;
      }
      const mode = tab.mode ?? 'http';
      const method = tab.request?.method ?? '';
      const url = tab.request?.url ?? '';
      const status = tab.response?.status;
      const parts = [mode.toUpperCase(), `${method} ${url || '(no URL)'}`.trim()];
      if (status) parts.push(`${status}`);
      setLabel(parts.filter(Boolean).join(' · '));
    };
    recompute();
    const unsubscribe = useRequestStore.subscribe(recompute);
    return () => {
      unsubscribe();
    };
  }, []);

  return (
    <div className="glass-1 border-border/40 mx-3 mt-2 truncate rounded-md border px-2 py-1 text-[11px] text-muted-foreground">
      <span aria-hidden>· </span>
      {label}
    </div>
  );
}
