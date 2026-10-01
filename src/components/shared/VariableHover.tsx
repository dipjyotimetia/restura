import type * as React from 'react';
import { useCallback, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useVariableDetails } from '@/hooks/useVariableStatus';
import { HELPERS } from '@/lib/shared/dynamicVariables';
import { variableSourceLabel } from '@/lib/shared/variableScopes';

interface HoverState {
  name: string;
  left: number;
  top: number;
}

/**
 * Hover cards for `{{var}}` tokens drawn by a VariableText overlay. The overlay
 * is `pointer-events-none` so the input underneath stays fully editable; the
 * container hit-tests the overlay's `[data-var]` spans on mouse move instead.
 */
export function useVariableHover() {
  const [hover, setHover] = useState<HoverState | null>(null);
  const details = useVariableDetails();
  const byName = useMemo(() => new Map(details.map((d) => [d.name, d])), [details]);

  const onMouseMove = useCallback((e: React.MouseEvent<HTMLElement>) => {
    let next: HoverState | null = null;
    for (const span of e.currentTarget.querySelectorAll<HTMLElement>('[data-var]')) {
      const r = span.getBoundingClientRect();
      if (
        e.clientX >= r.left &&
        e.clientX <= r.right &&
        e.clientY >= r.top &&
        e.clientY <= r.bottom
      ) {
        next = { name: span.dataset.var ?? '', left: r.left, top: r.bottom + 6 };
        break;
      }
    }
    setHover((prev) =>
      prev?.name === next?.name && prev?.left === next?.left && prev?.top === next?.top
        ? prev
        : next
    );
  }, []);
  const onMouseLeave = useCallback(() => setHover(null), []);

  let card: React.ReactNode = null;
  if (hover) {
    const detail = byName.get(hover.name);
    const isHelper = hover.name.startsWith('$');
    let body: React.ReactNode;
    if (isHelper) {
      body =
        hover.name.slice(1) in HELPERS
          ? 'Dynamic value, generated at send time'
          : 'Unknown dynamic variable';
    } else if (!detail) {
      body = 'Not defined in any active scope';
    } else if (detail.value === undefined) {
      body = detail.source === 'script' ? 'Set by the pre-request script' : 'Stored secret';
    } else {
      body = (
        <span className="font-mono text-sp-text break-all">
          {detail.secret ? '••••••••' : detail.value || <em className="text-sp-dim">empty</em>}
        </span>
      );
    }
    card = createPortal(
      <div
        role="tooltip"
        className="fixed z-50 max-w-xs rounded-sp-btn border border-sp-line bg-sp-surface-hi px-2.5 py-1.5 text-sp-12 shadow-lg pointer-events-none"
        style={{ left: hover.left, top: hover.top }}
      >
        <div className="flex items-center gap-2">
          <span className="font-mono text-sp-accent">{hover.name}</span>
          {detail && <span className="text-sp-dim">{variableSourceLabel(detail.source)}</span>}
        </div>
        <div className="text-sp-muted">{body}</div>
      </div>,
      document.body
    );
  }

  return { onMouseMove, onMouseLeave, card };
}
