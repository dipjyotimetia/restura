import { Eraser } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
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
import { type KafkaResetGroupOffsetsParams, kafkaManager } from '@/features/kafka/lib/kafkaManager';
import type {
  KafkaOffsetResetRow,
  KafkaOffsetResetSkip,
  KafkaOffsetResetTarget,
  KafkaPartitionLag,
} from '../../../../electron/types/electron-api';
import { partitionColor } from './shared';

type AsyncResult = { ok: true } | { ok: false; error: string };
type Run = <R extends AsyncResult>(action: () => Promise<R>) => Promise<R>;

/** Scope sentinel — `*` is not a legal Kafka topic character, so it can't collide. */
const ALL_TOPICS = '*';

const TARGET_LABELS: Record<KafkaOffsetResetTarget, string> = {
  earliest: 'earliest',
  latest: 'latest',
  specific: 'specific',
  timestamp: 'to date/time',
  shift: 'shift by ±N',
};

const NOTE_LABELS: Record<NonNullable<KafkaOffsetResetRow['note']>, string> = {
  'timestamp-fallback-latest': 'no record at/after time → latest',
  'clamped-earliest': 'clamped to earliest',
  'clamped-latest': 'clamped to latest',
};

interface Outcome {
  kind: 'preview' | 'applied';
  offsets: KafkaOffsetResetRow[];
  skipped: KafkaOffsetResetSkip[];
}

/**
 * Consumer-group offset reset + delete-offsets (KIP-496) controls for the group
 * inspector. Targets: earliest / latest / specific / timestamp / shift, scoped to
 * one committed topic or every committed topic. "Preview" runs a dry run and
 * shows the planned offsets; applying and deleting are confirm-gated. The group
 * must be inactive — main rejects otherwise and the error surfaces inline.
 */
export function KafkaOffsetResetPanel({
  connectionId,
  groupId,
  offsets,
  busy,
  run,
  onChanged,
}: {
  connectionId: string;
  groupId: string;
  offsets: KafkaPartitionLag[];
  busy: boolean;
  run: Run;
  onChanged: () => Promise<void>;
}) {
  const [scope, setScope] = useState('');
  const [to, setTo] = useState<KafkaOffsetResetTarget>('latest');
  const [specific, setSpecific] = useState<Record<number, string>>({});
  const [dateTime, setDateTime] = useState('');
  const [shift, setShift] = useState('');
  const [confirm, setConfirm] = useState<'reset' | 'delete' | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [deletedNote, setDeletedNote] = useState<string | null>(null);

  const committedTopics = useMemo(
    () => Array.from(new Set(offsets.map((o) => o.topic))).sort(),
    [offsets]
  );
  const allTopics = scope === ALL_TOPICS;
  const scopePartitions = useMemo(
    () => (allTopics ? [] : offsets.filter((offset) => offset.topic === scope)),
    [offsets, scope, allTopics]
  );

  // Keep the scope selection valid as offsets load / change.
  useEffect(() => {
    if (committedTopics.length === 0) {
      if (scope !== '') setScope('');
    } else if (scope !== ALL_TOPICS && !committedTopics.includes(scope)) {
      setScope(committedTopics[0] ?? '');
    }
  }, [committedTopics, scope]);

  useEffect(() => {
    setSpecific((current) =>
      Object.fromEntries(
        scopePartitions.map((offset) => [
          offset.partition,
          current[offset.partition] ?? offset.committed ?? '0',
        ])
      )
    );
  }, [scopePartitions]);

  // Any input change invalidates a pending confirmation and a stale preview.
  useEffect(() => {
    setConfirm(null);
    setOutcome((current) => (current?.kind === 'preview' ? null : current));
  }, [scope, to, specific, dateTime, shift]);

  useEffect(() => {
    if (allTopics && to === 'specific') setTo('latest');
  }, [allTopics, to]);

  const timestampMs = dateTime ? new Date(dateTime).getTime() : Number.NaN;
  const invalid =
    !scope ||
    (to === 'specific' &&
      scopePartitions.some((o) => !/^\d+$/.test(specific[o.partition]?.trim() ?? ''))) ||
    (to === 'timestamp' && !(Number.isFinite(timestampMs) && timestampMs >= 0)) ||
    (to === 'shift' && !/^[+-]?\d{1,15}$/.test(shift.trim()));

  const buildParams = (dryRun: boolean): KafkaResetGroupOffsetsParams => ({
    connectionId,
    groupId,
    ...(allTopics ? { allTopics: true } : { topic: scope }),
    to,
    ...(to === 'specific'
      ? {
          partitions: scopePartitions.map((o) => ({
            partition: o.partition,
            offset: specific[o.partition]?.trim() ?? '',
          })),
        }
      : {}),
    ...(to === 'timestamp' ? { timestamp: timestampMs } : {}),
    ...(to === 'shift' ? { shift: Number(shift.trim()) } : {}),
    ...(dryRun ? { dryRun: true } : {}),
  });

  const submitReset = async (dryRun: boolean): Promise<void> => {
    if (invalid) return;
    setConfirm(null);
    setDeletedNote(null);
    const result = await run(() => kafkaManager.resetGroupOffsets(buildParams(dryRun)));
    if (!result.ok) return;
    setOutcome({
      kind: dryRun ? 'preview' : 'applied',
      offsets: result.offsets,
      skipped: result.skipped,
    });
    if (!dryRun) await onChanged();
  };

  const submitDelete = async (): Promise<void> => {
    if (!scope) return;
    setConfirm(null);
    setOutcome(null);
    const result = await run(() =>
      kafkaManager.deleteGroupOffsets({
        connectionId,
        groupId,
        ...(allTopics ? { allTopics: true } : { topic: scope }),
      })
    );
    if (!result.ok) return;
    const count = result.deleted.reduce((sum, t) => sum + t.partitions.length, 0);
    setDeletedNote(`Deleted committed offsets for ${count} partition(s).`);
    await onChanged();
  };

  if (committedTopics.length === 0) return null;
  const scopeLabel = allTopics ? 'all committed topics' : scope;

  return (
    <div className="space-y-2 rounded-sp-btn border border-sp-line p-2">
      <Label className="text-xs sp-label">Reset offsets</Label>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={scope} onValueChange={setScope}>
          <SelectTrigger className="h-8 w-44 text-xs font-mono" aria-label="Reset scope">
            <SelectValue placeholder="topic" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_TOPICS} className="text-xs">
              All committed topics
            </SelectItem>
            {committedTopics.map((t) => (
              <SelectItem key={t} value={t} className="text-xs font-mono">
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={to} onValueChange={(v) => setTo(v as KafkaOffsetResetTarget)}>
          <SelectTrigger className="h-8 w-36 text-xs" aria-label="Reset target">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(TARGET_LABELS) as KafkaOffsetResetTarget[])
              .filter((target) => !(allTopics && target === 'specific'))
              .map((target) => (
                <SelectItem key={target} value={target} className="text-xs">
                  {TARGET_LABELS[target]}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
        {to === 'specific' &&
          scopePartitions.map((offset) => (
            <Input
              key={offset.partition}
              value={specific[offset.partition] ?? ''}
              onChange={(e) =>
                setSpecific((current) => ({ ...current, [offset.partition]: e.target.value }))
              }
              inputMode="numeric"
              placeholder={`P${offset.partition} offset`}
              className="h-8 w-28 text-xs font-mono"
              title={`Offset for partition ${offset.partition}`}
            />
          ))}
        {to === 'timestamp' && (
          <Input
            type="datetime-local"
            step="1"
            value={dateTime}
            onChange={(e) => setDateTime(e.target.value)}
            className="h-8 w-52 text-xs font-mono"
            title="Reset to the first record at or after this local date/time"
            aria-label="Reset date/time"
          />
        )}
        {to === 'shift' && (
          <Input
            value={shift}
            onChange={(e) => setShift(e.target.value)}
            inputMode="numeric"
            placeholder="-100 or +50"
            className="h-8 w-28 text-xs font-mono"
            title="Move each committed offset by this many records (clamped to the log range)"
            aria-label="Shift by"
          />
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void submitReset(true)}
          disabled={busy || invalid}
        >
          Preview
        </Button>
        {confirm === 'reset' ? (
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant="destructive"
              onClick={() => void submitReset(false)}
              disabled={busy}
            >
              {allTopics ? 'Confirm reset (all topics)' : 'Confirm reset'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setConfirm('reset')}
            disabled={busy || invalid}
          >
            Reset
          </Button>
        )}
      </div>

      {outcome && <OffsetOutcomeTable outcome={outcome} />}

      <div className="flex flex-wrap items-center gap-2">
        {confirm === 'delete' ? (
          <>
            <Button size="sm" variant="destructive" onClick={submitDelete} disabled={busy}>
              <Eraser className="h-3.5 w-3.5 mr-1.5" /> Confirm delete offsets ({scopeLabel})
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setConfirm('delete')}
            disabled={busy || !scope}
            className="text-red-400 hover:text-red-300"
          >
            <Eraser className="h-3.5 w-3.5 mr-1.5" /> Delete offsets
          </Button>
        )}
        {deletedNote && <span className="text-sp-11 text-sp-muted">{deletedNote}</span>}
      </div>
      <p className="text-sp-11 text-sp-dim">
        The group must be inactive (no members) to reset or delete committed offsets. Shift skips
        partitions with no committed offset; a date/time with no later record resets to latest.
      </p>
    </div>
  );
}

function OffsetOutcomeTable({ outcome }: { outcome: Outcome }) {
  return (
    <div className="space-y-1" data-testid="kafka-offset-outcome">
      <span className="text-sp-11 text-sp-muted">
        {outcome.kind === 'preview' ? 'Preview (not applied)' : 'Applied'} —{' '}
        {outcome.offsets.length} partition(s)
        {outcome.skipped.length > 0 &&
          `, ${outcome.skipped.length} skipped (no committed offset): ${outcome.skipped
            .map((s) => `${s.topic}/P${s.partition}`)
            .join(', ')}`}
      </span>
      {outcome.offsets.length > 0 && (
        <ScrollArea className="max-h-40">
          <table className="w-full text-sp-11 font-mono tabular-nums">
            <thead className="text-sp-dim">
              <tr className="border-b border-sp-line">
                <th className="px-2 py-1 text-left font-medium">Topic</th>
                <th className="px-2 py-1 text-left font-medium">P</th>
                <th className="px-2 py-1 text-right font-medium">Current</th>
                <th className="px-2 py-1 text-right font-medium">New</th>
                <th className="px-2 py-1 text-left font-medium">Note</th>
              </tr>
            </thead>
            <tbody>
              {outcome.offsets.map((row) => (
                <tr
                  key={`${row.topic}/${row.partition}`}
                  className="border-b border-sp-line/60 last:border-0"
                >
                  <td className="px-2 py-1 text-sp-muted truncate" title={row.topic}>
                    {row.topic}
                  </td>
                  <td className="px-2 py-1" style={{ color: partitionColor(row.partition) }}>
                    P{row.partition}
                  </td>
                  <td className="px-2 py-1 text-right text-sp-muted">{row.previous ?? '—'}</td>
                  <td className="px-2 py-1 text-right text-sp-text">{row.offset}</td>
                  <td className="px-2 py-1 text-sp-dim">{row.note ? NOTE_LABELS[row.note] : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollArea>
      )}
    </div>
  );
}
