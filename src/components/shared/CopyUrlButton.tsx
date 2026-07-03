import { Link2 } from 'lucide-react';
import { cn } from '@/lib/shared/utils';

interface CopyUrlButtonProps {
  url: string;
  /** Icon button footprint — `UrlBar` uses the larger `md`, `GrpcInvocationBar`'s tighter pill uses `sm`. */
  size?: 'sm' | 'md';
  ariaLabel?: string;
  className?: string;
}

const SIZE_CLASSES: Record<NonNullable<CopyUrlButtonProps['size']>, string> = {
  sm: 'h-6 w-6',
  md: 'h-7 w-7',
};

/** Icon button that copies a URL to the clipboard, shared by the HTTP and gRPC invocation bars. */
export function CopyUrlButton({
  url,
  size = 'md',
  ariaLabel = 'Copy URL',
  className,
}: CopyUrlButtonProps) {
  return (
    <button
      type="button"
      onClick={() => {
        if (!url) return;
        void navigator.clipboard?.writeText(url);
      }}
      disabled={!url}
      aria-label={ariaLabel}
      className={cn(
        'inline-flex items-center justify-center rounded-sp-btn text-sp-dim',
        SIZE_CLASSES[size],
        'hover:text-sp-text hover:bg-sp-hover transition-colors',
        'disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent',
        className
      )}
    >
      <Link2 className="h-3.5 w-3.5" />
    </button>
  );
}

export default CopyUrlButton;
