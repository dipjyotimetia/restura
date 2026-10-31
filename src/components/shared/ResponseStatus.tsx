import { StatusPill } from '@/components/ui/spatial';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { describeHttpStatus } from '@/lib/shared/httpStatus';

/** Response status pill with a plain-language explanation on hover/focus. */
export function ResponseStatus({ status, statusText }: { status: number; statusText: string }) {
  const pill = <StatusPill status={status} text={statusText} />;
  const explanation = describeHttpStatus(status);
  if (!explanation) return pill;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* Focusable so keyboard users get the explanation too. */}
        <span
          tabIndex={0}
          className="rounded-sp-btn focus:outline-none focus-visible:ring-2 focus-visible:ring-sp-accent"
        >
          {pill}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{explanation}</TooltipContent>
    </Tooltip>
  );
}
