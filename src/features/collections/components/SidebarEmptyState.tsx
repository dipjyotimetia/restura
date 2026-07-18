import type { LucideIcon } from 'lucide-react';

/** Quiet empty state shared by the collections / history / workflows tabs. */
export function SidebarEmptyState({
  icon: Icon,
  title,
  hint,
}: {
  icon: LucideIcon;
  title: string;
  hint: string;
}) {
  return (
    <div className="text-center text-xs py-10 px-3">
      <Icon className="mx-auto mb-2.5 h-5 w-5 text-sp-dim" />
      <p className="text-muted-foreground">{title}</p>
      <p className="text-[11px] mt-1 text-sp-dim">{hint}</p>
    </div>
  );
}
