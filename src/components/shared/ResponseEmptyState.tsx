import type { ReactNode } from 'react';
import { Floater } from '@/components/ui/spatial';

export interface ResponseEmptyStateProps {
  icon: ReactNode;
  message: string;
  /** Optional extra row under the message, e.g. a keyboard-shortcut hint. */
  hint?: ReactNode;
}

/**
 * Centered idle-state panel shared by the protocol response viewers
 * (HTTP ResponseViewer, GrpcResponsePanel) so they stay visually identical.
 */
export function ResponseEmptyState({ icon, message, hint }: ResponseEmptyStateProps) {
  return (
    <Floater
      radius="panel"
      elevation="float-lg"
      className="h-full flex flex-col items-center justify-center text-sp-dim relative z-20"
    >
      <div className="flex flex-col items-center gap-3 animate-sp-panel-in">
        <div className="flex items-center justify-center size-10 rounded-full bg-sp-surface-lo border border-sp-line">
          {icon}
        </div>
        <p className="text-sp-12 text-sp-muted">{message}</p>
        {hint}
      </div>
    </Floater>
  );
}

export default ResponseEmptyState;
