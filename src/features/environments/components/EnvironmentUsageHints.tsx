import { Eye, KeyRound, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Floater } from '@/components/ui/spatial';
import { cn } from '@/lib/shared/utils';

type UsageHintTab = 'variable' | 'dynamic' | 'secret';

const USAGE_HINT_TABS: Array<{
  id: UsageHintTab;
  label: string;
  icon: typeof Eye;
}> = [
  { id: 'variable', label: '{{variable}}', icon: Eye },
  { id: 'dynamic', label: '{{$dynamic}}', icon: Sparkles },
  { id: 'secret', label: 'Secrets', icon: KeyRound },
];

export function EnvironmentUsageHints() {
  const [tab, setTab] = useState<UsageHintTab>('variable');
  const panelId = `usage-hints-${tab}`;
  const tabId = `${panelId}-tab`;

  return (
    <Floater radius="panel" elevation="inset" className="p-3">
      <div role="tablist" aria-label="Variable syntax" className="flex items-center gap-1 mb-2.5">
        {USAGE_HINT_TABS.map((usageHintTab) => {
          const Icon = usageHintTab.icon;
          const active = tab === usageHintTab.id;
          return (
            <button
              key={usageHintTab.id}
              type="button"
              role="tab"
              id={`usage-hints-${usageHintTab.id}-tab`}
              aria-selected={active}
              aria-controls={`usage-hints-${usageHintTab.id}`}
              onClick={() => setTab(usageHintTab.id)}
              className={cn(
                'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-sp-btn transition-colors',
                'text-sp-11-5 font-medium',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent',
                active
                  ? 'bg-sp-active text-sp-accent'
                  : 'text-sp-muted hover:text-sp-text hover:bg-sp-hover'
              )}
            >
              <Icon size={12} />
              <span className="font-mono">{usageHintTab.label}</span>
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id={panelId}
        aria-labelledby={tabId}
        className="text-sp-12 text-sp-muted leading-relaxed"
      >
        {tab === 'variable' && (
          <>
            Reference a variable from anywhere — URL, headers, body, scripts — with{' '}
            <code className="font-mono text-sp-text">{'{{variableName}}'}</code>. Active environment
            wins; missing variables surface as inline warnings before the request fires.
          </>
        )}
        {tab === 'dynamic' && (
          <>
            Built-in helpers expand at send time:{' '}
            <code className="font-mono text-sp-text">{'{{$timestamp}}'}</code>,{' '}
            <code className="font-mono text-sp-text">{'{{$guid}}'}</code>,{' '}
            <code className="font-mono text-sp-text">{'{{$randomInt}}'}</code>,{' '}
            <code className="font-mono text-sp-text">{'{{$isoDate}}'}</code>. They override
            environment variables of the same name.
          </>
        )}
        {tab === 'secret' && (
          <>
            Click <KeyRound size={11} className="inline align-text-bottom text-amber-400" /> next to
            a variable to mark it as secret — the value is masked in the UI and in collection
            exports. This is display-only: the value is still stored as plaintext, and pre-request /
            test scripts can read it via{' '}
            <code className="font-mono text-sp-text">pm.environment</code>. For OS-keychain
            protection, use a request's Auth tab instead, where supported credential fields can be
            stored as a handle via Settings → Secrets.
          </>
        )}
      </div>
    </Floater>
  );
}
