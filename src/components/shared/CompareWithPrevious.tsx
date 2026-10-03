import { GitCompare } from 'lucide-react';
import { useMemo, useState } from 'react';
import { IconButton } from '@/components/shared/ResponseToolbarButtons';
import { lazyComponent } from '@/lib/shared/lazyComponent';
import { previousHistoryItem, toCompareEntry } from '@/lib/shared/previousResponse';
import { useHistoryStore } from '@/store/useHistoryStore';
import type { Request, Response } from '@/types';

const EntryCompareDialog = lazyComponent(
  () => import('@/features/http/components/NetworkConsole/EntryCompareDialog')
);

/**
 * Toolbar action comparing the current response with the previous one for
 * the same request (from history). Hidden when there's nothing to compare.
 */
export function CompareWithPrevious({
  request,
  response,
}: {
  request: Request;
  response: Response;
}) {
  const history = useHistoryStore((s) => s.history);
  const [open, setOpen] = useState(false);
  const previous = useMemo(
    () => previousHistoryItem(history, request.id, response),
    [history, request.id, response]
  );
  if (!previous?.response) return null;

  return (
    <>
      <IconButton
        icon={<GitCompare className="h-3.5 w-3.5" />}
        label="Compare with previous response"
        onClick={() => setOpen(true)}
      />
      {open && (
        <EntryCompareDialog
          open={open}
          onOpenChange={setOpen}
          left={toCompareEntry(previous, previous.response)}
          right={toCompareEntry(
            // Its own history entry records the resolved URL; fall back to the tab.
            history.find((item) => item.response?.id === response.id) ?? {
              id: 'current',
              request,
              timestamp: response.timestamp,
            },
            response
          )}
        />
      )}
    </>
  );
}
