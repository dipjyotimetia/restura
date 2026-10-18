import { Braces } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/shared/utils';
import type { McpResourceTemplateDescriptor } from '@/types';

/** Catalog list of `resources/templates/list` entries; selection opens the parameter form. */
export function McpTemplatesPanel({
  templates,
  selected,
  onSelect,
}: {
  templates: McpResourceTemplateDescriptor[];
  selected: string | null;
  onSelect: (uriTemplate: string) => void;
}) {
  if (templates.length === 0) {
    return (
      <div className="h-full grid place-items-center px-4">
        <div className="text-center">
          <div className="font-mono text-sp-12 text-sp-muted">No templates</div>
          <div className="mt-1 text-sp-11-5 text-sp-dim">
            The server exposes no resource templates.
          </div>
        </div>
      </div>
    );
  }
  return (
    <ScrollArea className="h-full">
      <div className="p-2 space-y-1">
        {templates.map((template) => {
          const isSelected = selected === template.uriTemplate;
          return (
            <button
              key={template.uriTemplate}
              type="button"
              onClick={() => onSelect(template.uriTemplate)}
              className={cn(
                'w-full text-left rounded-sp-btn px-2.5 py-2 transition-colors',
                'border border-transparent',
                isSelected ? 'bg-sp-active' : 'hover:bg-sp-hover'
              )}
              style={isSelected ? { borderColor: 'var(--sp-accent-glow-55)' } : undefined}
            >
              <div className="flex items-center gap-1.5 min-w-0">
                <Braces
                  className="h-3.5 w-3.5 shrink-0"
                  style={{ color: 'var(--color-warning)' }}
                />
                <span className="font-mono font-bold text-sp-12 text-sp-text truncate">
                  {template.name}
                </span>
              </div>
              <div className="mt-0.5 ml-5 text-sp-11 font-mono text-sp-dim truncate">
                {template.uriTemplate}
              </div>
              {template.description && (
                <div className="mt-1 ml-5 text-sp-11-5 text-sp-muted line-clamp-2">
                  {template.description}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </ScrollArea>
  );
}
