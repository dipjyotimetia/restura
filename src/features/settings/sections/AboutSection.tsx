import type { ReactNode } from 'react';
import { Info, ShieldCheck } from 'lucide-react';
import { Logo } from '@/components/shared/Logo';
import { Floater } from '@/components/ui/spatial';
import { cn } from '@/lib/shared/utils';
import { SectionHeader, SectionLabel } from '../components/SettingsSectionPrimitives';
import { GithubMark } from './ShortcutsSection';

export function AboutSection() {
  const version = import.meta.env.VITE_APP_VERSION || '0.0.0';

  return (
    <>
      <SectionHeader icon={Info} title="About" description="Build details and project links." />

      {/* Hero card — large logo + brand + version pill + tagline. Anchors
          the About page so it doesn't read as a settings list. */}
      <Floater radius="panel" elevation="inset" className="p-6 mt-2 relative overflow-hidden">
        <div
          aria-hidden="true"
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              'radial-gradient(circle at 0% 0%, var(--sp-accent-glow-33), transparent 55%)',
          }}
        />
        <div className="relative flex items-center gap-5">
          <Logo size={64} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2.5 flex-wrap">
              <span className="text-sp-22 font-bold text-sp-text leading-none">Restura</span>
              <span
                className="inline-flex items-center px-2 h-5 rounded-sp-pill text-sp-11 font-mono font-semibold text-sp-accent border border-sp-line"
                style={{ background: 'var(--sp-accent-glow-33)' }}
              >
                v{version}
              </span>
            </div>
            <p className="text-sp-13 text-sp-muted mt-1.5">
              A modern multi-protocol API client for HTTP, GraphQL, gRPC, WebSocket, and more.
            </p>
            <p className="text-sp-11 text-sp-dim mt-1 font-mono">Spatial Depth design system</p>
          </div>
        </div>
      </Floater>

      <section className="mt-5">
        <SectionLabel>Resources</SectionLabel>
        <div className="grid grid-cols-2 gap-2.5">
          <LinkCard
            icon={<GithubMark size={16} />}
            label="GitHub repository"
            hint="Source code & issues"
            href="https://github.com/dipjyotimetia/restura"
          />
          <LinkCard
            icon={<Info size={16} />}
            label="Documentation"
            hint="docs.restura.dev"
            href="https://docs.restura.dev"
          />
          <LinkCard
            icon={<ShieldCheck size={16} />}
            label="Privacy Policy"
            hint="restura.dev/privacy"
            href="https://restura.dev/privacy"
          />
        </div>
      </section>
    </>
  );
}

interface LinkCardProps {
  icon: ReactNode;
  label: string;
  hint: string;
  href: string;
}

function LinkCard({ icon, label, hint, href }: LinkCardProps) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className={cn(
        'group flex items-center gap-3 p-3 rounded-sp-btn',
        'bg-sp-surface-lo border border-sp-line',
        'hover:border-sp-accent hover:bg-sp-hover transition-colors',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent'
      )}
    >
      <div
        aria-hidden="true"
        className="flex items-center justify-center size-9 rounded-sp-btn shrink-0 text-sp-muted group-hover:text-sp-accent transition-colors"
        style={{ background: 'var(--sp-surface)' }}
      >
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sp-13 font-semibold text-sp-text">{label}</div>
        <div className="text-sp-11-5 text-sp-muted font-mono truncate">{hint}</div>
      </div>
    </a>
  );
}
