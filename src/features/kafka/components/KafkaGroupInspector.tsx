import { RefreshCw, X, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type {
  KafkaGroupDescription,
  KafkaPartitionLag,
} from '../../../../electron/types/electron-api';
import { partitionColor } from './shared';
import { useInspectorFetch } from './useInspectorFetch';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { kafkaManager } from '@/features/kafka/lib/kafkaManager';

type ResetTarget = 'earliest' | 'latest' | 'specific';

function stateTone(state: string): 'green' | 'amber' | 'muted' {
  if (state === 'STABLE') return 'green';
  if (state === 'EMPTY' || state === 'DEAD') return 'muted';
  return 'amber';
}

const TONE_COLOR: Record<'green' | 'amber' | 'muted', string> = {
  green: '#22c55e',
  amber: '#f59e0b',
  muted: '#94a3b8',
};

/**
 * Consumer-group inspector — members/state, per-partition committed offset, topic
 * log-end and computed lag, plus offset-reset and delete-group actions. Reset and
 * delete require an inactive group broker-side; that rejection surfaces inline.
 */
export function KafkaGroupInspector({
  connectionId,
  groupId,
  onClose,
  onDeleted,
}: {
  connectionId: string;
  groupId: string;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [group, setGroup] = useState<KafkaGroupDescription | null>(null);
  const [offsets, setOffsets] = useState<KafkaPartitionLag[] | null>(null);

  // Offset-reset form (per group; applies to one committed topic).
  const [resetTopic, setResetTopic] = useState('');
  const [resetTo, setResetTo] = useState<ResetTarget>('latest');
  const [resetOffset, setResetOffset] = useState('0');
  const [resetConfirm, setResetConfirm] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  const { busy, error, refresh, run } = useInspectorFetch(
    `${connectionId}:${groupId}`,
    async () => {
      const result = await kafkaManager.inspectGroup(connectionId, groupId);
      if (result.ok) {
        setGroup(result.group);
        setOffsets(result.offsets);
      }
      return result;
    }
  );

  const committedTopics = useMemo(
    () => Array.from(new Set((offsets ?? []).map((o) => o.topic))).sort(),
    [offsets]
  );

  // Keep the reset-topic selection valid as offsets load / change.
  useEffect(() => {
    if (committedTopics.length === 0) {
      if (resetTopic !== '') setResetTopic('');
    } else if (!committedTopics.includes(resetTopic)) {
      setResetTopic(committedTopics[0] ?? '');
    }
  }, [committedTopics, resetTopic]);

  const handleReset = async (): Promise<void> => {
    if (!resetTopic) return;
    setResetConfirm(false);
    const partitions =
      resetTo === 'specific'
        ? (offsets ?? [])
            .filter((o) => o.topic === resetTopic)
            .map((o) => ({ partition: o.partition, offset: resetOffset.trim() }))
        : undefined;
    const result = await run(() =>
      kafkaManager.resetGroupOffsets({
        connectionId,
        groupId,
        topic: resetTopic,
        to: resetTo,
        ...(partitions ? { partitions } : {}),
      })
    );
    if (result.ok) await refresh();
  };

  const handleDelete = async (): Promise<void> => {
    setDeleteConfirm(false);
    const result = await run(() => kafkaManager.deleteGroup(connectionId, groupId));
    if (result.ok) onDeleted();
  };

  const tone = group ? stateTone(group.state) : 'muted';
  const resetOffsetInvalid = resetTo === 'specific' && !/^\d+$/.test(resetOffset.trim());

  return (
    <div className="space-y-3 rounded-sp-btn border border-sp-line p-3 bg-sp-surface-lo">
      <div className="flex items-center gap-2">
        <Label className="text-xs sp-label">Group</Label>
        <span className="font-mono text-sp-12 text-sp-text truncate" title={groupId}>
          {groupId}
        </span>
        {group && (
          <Badge
            variant="outline"
            className="font-mono text-sp-11"
            style={{ color: TONE_COLOR[tone], borderColor: `${TONE_COLOR[tone]}55` }}
          >
            {group.state}
          </Badge>
        )}
        <Button
          size="sm"
          variant="secondary"
          onClick={() => void refresh()}
          disabled={busy}
          className="ml-auto"
        >
          <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Refresh
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={onClose}
          className="h-7 w-7 p-0"
          title="Close inspector"
          aria-label="Close group inspector"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      {error && <div className="font-mono text-sp-12 text-red-400 break-all">{error}</div>}

      {/* Members */}
      <div className="space-y-1.5">
        <Label className="text-xs sp-label">Members ({group?.members.length ?? 0})</Label>
        {group && group.members.length > 0 ? (
          <ul className="space-y-1">
            {group.members.map((m) => (
              <li
                key={m.memberId}
                className="rounded-sp-btn border border-sp-line px-2 py-1 text-sp-11 font-mono"
              >
                <div className="flex items-center gap-2">
                  <span className="text-sp-text truncate" title={m.clientId}>
                    {m.clientId || m.memberId}
                  </span>
                  <span className="text-sp-dim truncate" title={m.clientHost}>
                    {m.clientHost}
                  </span>
                </div>
                {m.assignments.length > 0 && (
                  <div className="mt-0.5 flex flex-wrap gap-1">
                    {m.assignments.map((a) => (
                      <span key={a.topic} className="text-sp-muted">
                        {a.topic}[{a.partitions.join(',')}]
                      </span>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-sp-dim">No active members (group is idle).</p>
        )}
      </div>

      {/* Committed offsets + lag */}
      <div className="space-y-1.5">
        <Label className="text-xs sp-label">Offsets &amp; lag</Label>
        {offsets === null ? (
          <p className="text-xs text-sp-dim">Loading…</p>
        ) : offsets.length === 0 ? (
          <p className="text-xs text-sp-dim">No committed offsets for this group.</p>
        ) : (
          <ScrollArea className="max-h-56">
            <table className="w-full text-sp-11 font-mono tabular-nums">
              <thead className="text-sp-dim">
                <tr className="border-b border-sp-line">
                  <th className="px-2 py-1 text-left font-medium">Topic</th>
                  <th className="px-2 py-1 text-left font-medium">P</th>
                  <th className="px-2 py-1 text-right font-medium">Committed</th>
                  <th className="px-2 py-1 text-right font-medium">Log end</th>
                  <th className="px-2 py-1 text-right font-medium">Lag</th>
                </tr>
              </thead>
              <tbody>
                {offsets.map((o) => {
                  const lagN = Number(o.lag);
                  return (
                    <tr
                      key={`${o.topic}/${o.partition}`}
                      className="border-b border-sp-line/60 last:border-0"
                    >
                      <td className="px-2 py-1 text-sp-muted truncate" title={o.topic}>
                        {o.topic}
                      </td>
                      <td className="px-2 py-1" style={{ color: partitionColor(o.partition) }}>
                        P{o.partition}
                      </td>
                      <td className="px-2 py-1 text-right text-sp-muted">{o.committed ?? '—'}</td>
                      <td className="px-2 py-1 text-right text-sp-text">{o.logEnd}</td>
                      <td
                        className="px-2 py-1 text-right font-bold"
                        style={{ color: lagN > 0 ? '#f59e0b' : '#22c55e' }}
                      >
                        {lagN.toLocaleString()}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </ScrollArea>
        )}
      </div>

      {/* Reset offsets */}
      {committedTopics.length > 0 && (
        <div className="space-y-2 rounded-sp-btn border border-sp-line p-2">
          <Label className="text-xs sp-label">Reset offsets</Label>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={resetTopic} onValueChange={setResetTopic}>
              <SelectTrigger className="h-8 w-40 text-xs font-mono">
                <SelectValue placeholder="topic" />
              </SelectTrigger>
              <SelectContent>
                {committedTopics.map((t) => (
                  <SelectItem key={t} value={t} className="text-xs font-mono">
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={resetTo} onValueChange={(v) => setResetTo(v as ResetTarget)}>
              <SelectTrigger className="h-8 w-32 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="earliest" className="text-xs">
                  earliest
                </SelectItem>
                <SelectItem value="latest" className="text-xs">
                  latest
                </SelectItem>
                <SelectItem value="specific" className="text-xs">
                  specific
                </SelectItem>
              </SelectContent>
            </Select>
            {resetTo === 'specific' && (
              <Input
                value={resetOffset}
                onChange={(e) => setResetOffset(e.target.value)}
                inputMode="numeric"
                placeholder="offset"
                className="h-8 w-24 text-xs font-mono"
                title="Offset applied to every partition of the selected topic"
              />
            )}
            {resetConfirm ? (
              <div className="flex items-center gap-1.5">
                <Button size="sm" variant="destructive" onClick={handleReset} disabled={busy}>
                  Confirm reset
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setResetConfirm(false)}>
                  Cancel
                </Button>
              </div>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setResetConfirm(true)}
                disabled={busy || !resetTopic || resetOffsetInvalid}
              >
                Reset
              </Button>
            )}
          </div>
          <p className="text-sp-11 text-sp-dim">
            The group must be inactive (no members) to reset committed offsets.
          </p>
        </div>
      )}

      {/* Delete group */}
      <div className="flex items-center gap-2">
        {deleteConfirm ? (
          <>
            <Button size="sm" variant="destructive" onClick={handleDelete} disabled={busy}>
              <Trash2 className="h-3.5 w-3.5 mr-1.5" /> Confirm delete
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setDeleteConfirm(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setDeleteConfirm(true)}
            disabled={busy}
            className="text-red-400 hover:text-red-300"
          >
            <Trash2 className="h-3.5 w-3.5 mr-1.5" /> Delete group
          </Button>
        )}
        <span className="text-sp-11 text-sp-dim">Group must be empty to delete.</span>
      </div>
    </div>
  );
}
