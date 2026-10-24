import { useEffect, useId, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  type KafkaSeekTarget,
  type KafkaTopicPartition,
  pauseKafkaPartitions,
  resumeKafkaPartitions,
  seekKafkaPartition,
} from '@/features/kafka/lib/partitionControl';
import { type KafkaConnection, useKafkaStore } from '@/features/kafka/store/useKafkaStore';
import { partitionColor } from './shared';

interface PartitionRow extends KafkaTopicPartition {
  key: string;
  lag?: string;
  lastOffset?: string;
}

const rowKey = (topic: string, partition: number) => `${topic}:${partition}`;

/**
 * Assigned partitions come from the lag monitor (-1 = not assigned to this
 * member); partitions that delivered records are added too, so the table is
 * useful before the first lag tick.
 */
function partitionRows(connection: KafkaConnection): PartitionRow[] {
  const rows = new Map<string, PartitionRow>();
  for (const { topic, offsets } of connection.consumer.lag ?? []) {
    offsets.forEach((lag, partition) => {
      if (lag === '-1') return;
      rows.set(rowKey(topic, partition), { key: rowKey(topic, partition), topic, partition, lag });
    });
  }
  for (const m of connection.messages) {
    if (m.direction !== 'received' || m.partition === undefined || m.offset === undefined) continue;
    const key = rowKey(m.topic, m.partition);
    const row = rows.get(key) ?? { key, topic: m.topic, partition: m.partition };
    if (row.lastOffset === undefined || BigInt(m.offset) > BigInt(row.lastOffset)) {
      row.lastOffset = m.offset;
    }
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) =>
    a.topic === b.topic ? a.partition - b.partition : a.topic.localeCompare(b.topic)
  );
}

type SeekKind = KafkaSeekTarget['kind'];

function seekTarget(kind: SeekKind, draft: string): KafkaSeekTarget | undefined {
  if (kind === 'offset') {
    const offset = draft.trim();
    return /^\d+$/.test(offset) ? { kind, offset } : undefined;
  }
  const ms = new Date(draft).getTime();
  return Number.isFinite(ms) && ms >= 0 ? { kind, timestamp: String(ms) } : undefined;
}

/**
 * Live per-partition controls for a subscribed consumer (desktop): pause or
 * resume single partitions and seek one to an offset or timestamp without
 * resubscribing (#942).
 */
export function KafkaPartitionControls({ connection }: { connection: KafkaConnection }) {
  const subscribed = connection.consumer.status === 'subscribed';
  const rows = useMemo(() => partitionRows(connection), [connection]);
  // In the store (not local state) so it survives tab switches; cleared when the subscription ends.
  const paused = new Set(connection.consumer.pausedPartitions ?? []);
  const ids = useId();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null);
  const [seekKey, setSeekKey] = useState('');
  const [seekKind, setSeekKind] = useState<SeekKind>('offset');
  const [seekDraft, setSeekDraft] = useState('');

  useEffect(() => {
    if (!subscribed) setStatus(null);
  }, [subscribed]);

  if (!subscribed) return null;

  const selected = rows.find((r) => r.key === seekKey) ?? rows[0];
  const target = seekTarget(seekKind, seekDraft);

  const togglePartition = async (row: PartitionRow) => {
    const isPaused = paused.has(row.key);
    setBusy(true);
    const partitions = [{ topic: row.topic, partition: row.partition }];
    const result = isPaused
      ? await resumeKafkaPartitions(connection.id, partitions)
      : await pauseKafkaPartitions(connection.id, partitions);
    setBusy(false);
    if (!result.ok) {
      setStatus({ text: result.error, error: true });
      return;
    }
    useKafkaStore.getState().updateConsumer(connection.id, {
      pausedPartitions: result.paused.map((p) => rowKey(p.topic, p.partition)),
    });
    setStatus({
      text: `${isPaused ? 'Resumed' : 'Paused'} ${row.topic} partition ${row.partition}`,
    });
  };

  const seek = async () => {
    if (!selected || !target) return;
    setBusy(true);
    const result = await seekKafkaPartition(
      connection.id,
      { topic: selected.topic, partition: selected.partition },
      target
    );
    setBusy(false);
    setStatus(
      result.ok
        ? {
            text: `${selected.topic} partition ${selected.partition} ${
              paused.has(selected.key) ? 'will resume' : 'now reads'
            } from offset ${result.offset}`,
          }
        : { text: result.error, error: true }
    );
  };

  return (
    <section
      aria-labelledby={`${ids}-heading`}
      className="space-y-3 rounded-sp-btn border border-sp-line p-3 bg-sp-surface-lo"
    >
      <h3 id={`${ids}-heading`} className="text-xs font-medium">
        Partitions
      </h3>
      {rows.length === 0 ? (
        <p className="text-sp-11 text-sp-dim">
          Partitions appear once the consumer is assigned or receives records.
        </p>
      ) : (
        <table className="w-full text-xs">
          <thead className="text-left text-sp-dim">
            <tr>
              <th className="font-normal py-1">Topic</th>
              <th className="font-normal py-1">Partition</th>
              <th className="font-normal py-1">Lag</th>
              <th className="font-normal py-1">Last offset</th>
              <th className="font-normal py-1">State</th>
              <th className="py-1">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="font-mono">
            {rows.map((row) => {
              const isPaused = paused.has(row.key);
              return (
                <tr key={row.key} className="border-t border-sp-line">
                  <td className="py-1">{row.topic}</td>
                  <td className="py-1" style={{ color: partitionColor(row.partition) }}>
                    P{row.partition}
                  </td>
                  <td className="py-1">{row.lag ?? '—'}</td>
                  <td className="py-1">{row.lastOffset ?? '—'}</td>
                  <td className="py-1 font-sans">{isPaused ? 'Paused' : 'Running'}</td>
                  <td className="py-1 text-right">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      aria-label={`${isPaused ? 'Resume' : 'Pause'} ${row.topic} partition ${row.partition}`}
                      onClick={() => void togglePartition(row)}
                    >
                      {isPaused ? 'Resume' : 'Pause'}
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {rows.length > 0 && (
        <div className="grid grid-cols-1 gap-2 md:grid-cols-[1fr_auto_1fr_auto] md:items-end">
          <div className="space-y-1">
            <Label htmlFor={`${ids}-seek-partition`} className="text-xs sp-label">
              Seek partition
            </Label>
            <select
              id={`${ids}-seek-partition`}
              className="h-8 w-full rounded border border-sp-line bg-sp-surface px-2 text-xs font-mono"
              value={selected?.key ?? ''}
              onChange={(event) => setSeekKey(event.target.value)}
            >
              {rows.map((row) => (
                <option key={row.key} value={row.key}>
                  {row.topic} / P{row.partition}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${ids}-seek-kind`} className="text-xs sp-label">
              To
            </Label>
            <select
              id={`${ids}-seek-kind`}
              className="h-8 w-full rounded border border-sp-line bg-sp-surface px-2 text-xs"
              value={seekKind}
              onChange={(event) => {
                setSeekKind(event.target.value as SeekKind);
                setSeekDraft('');
              }}
            >
              <option value="offset">Offset</option>
              <option value="timestamp">Timestamp</option>
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${ids}-seek-value`} className="text-xs sp-label">
              {seekKind === 'offset' ? 'Offset' : 'Time'}
            </Label>
            <Input
              id={`${ids}-seek-value`}
              type={seekKind === 'offset' ? 'text' : 'datetime-local'}
              inputMode={seekKind === 'offset' ? 'numeric' : undefined}
              placeholder={seekKind === 'offset' ? '0' : undefined}
              value={seekDraft}
              onChange={(event) => setSeekDraft(event.target.value)}
              className="h-8 text-xs font-mono"
            />
          </div>
          <Button size="sm" disabled={busy || !target} onClick={() => void seek()}>
            Seek
          </Button>
        </div>
      )}
      {/* Always mounted so screen readers announce each update. */}
      <p
        role="status"
        className={`text-sp-11 ${status?.error ? 'text-destructive' : 'text-sp-dim'}`}
      >
        {status?.text}
      </p>
    </section>
  );
}
