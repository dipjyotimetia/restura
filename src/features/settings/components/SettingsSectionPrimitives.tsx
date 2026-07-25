import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Floater } from '@/components/ui/spatial';

interface SectionHeaderProps {
  icon: LucideIcon;
  title: string;
  description: ReactNode;
}

export function SectionHeader({ icon: Icon, title, description }: SectionHeaderProps) {
  return (
    <div className="flex items-start gap-3 mb-6">
      <div
        aria-hidden="true"
        className="shrink-0 flex items-center justify-center size-9 rounded-sp-btn border border-sp-line"
        style={{
          background:
            'linear-gradient(135deg, var(--sp-accent-glow-33), transparent 70%), var(--sp-surface-lo)',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)',
        }}
      >
        <Icon size={16} className="text-sp-accent" />
      </div>
      <div className="min-w-0">
        <h1 className="text-sp-22 font-bold text-sp-text leading-tight">{title}</h1>
        <p className="text-sp-13 text-sp-muted mt-0.5">{description}</p>
      </div>
    </div>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="sp-label mt-6 mb-2">{children}</div>;
}

interface FieldGroupProps {
  label: ReactNode;
  children: ReactNode;
}

/** Frames a labelled cluster of settings fields as one visual group. */
export function FieldGroup({ label, children }: FieldGroupProps) {
  return (
    <section className="mt-5 first:mt-0">
      <SectionLabel>{label}</SectionLabel>
      <Floater radius="panel" elevation="inset" className="px-4 divide-y divide-sp-line">
        {children}
      </Floater>
    </section>
  );
}

interface FieldRowProps {
  label: ReactNode;
  hint?: ReactNode;
  control: ReactNode;
}

export function FieldRow({ label, hint, control }: FieldRowProps) {
  return (
    <div className="grid grid-cols-[1fr_auto] items-center gap-4 py-3">
      <div className="min-w-0">
        <div className="text-sp-13 font-semibold text-sp-text">{label}</div>
        {hint && <div className="text-sp-11-5 text-sp-muted mt-0.5">{hint}</div>}
      </div>
      <div className="justify-self-end">{control}</div>
    </div>
  );
}
