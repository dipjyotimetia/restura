import { RefreshCw, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Switch } from '@/components/ui/switch';
import { kafkaManager } from '@/features/kafka/lib/kafkaManager';
import type {
  KafkaPartitionWatermark,
  KafkaTopicConfigEntry,
} from '../../../../electron/types/electron-api';
import { KAFKA_PINK, partitionColor } from './shared';
import { useInspectorFetch } from './useInspectorFetch';

/**
 * Topic inspector — per-partition watermarks (earliest/latest → message count)
 * plus the topic's broker config. Read-only; fetches on open and on Refresh.
 */
export function KafkaTopicInspector({
  connectionId,
  topic,
  onClose,
}: {
  connectionId: string;
  topic: string;
  onClose: () => void;
}) {
  const [partitions, setPartitions] = useState<KafkaPartitionWatermark[] | null>(null);
  const [config, setConfig] = useState<KafkaTopicConfigEntry[] | null>(null);
  const [showDefaults, setShowDefaults] = useState(false);

  const { busy, error, refresh } = useInspectorFetch(`${connectionId}:${topic}`, async () => {
    const result = await kafkaManager.inspectTopic(connectionId, topic);
    if (result.ok) {
      setPartitions(result.partitions);
      setConfig(result.config);
    }
    return result;
  });

  const totalMessages = (partitions ?? []).reduce((sum, p) => sum + Number(p.count), 0);
  const visibleConfig = (config ?? []).filter((c) => showDefaults || !c.isDefault);

  return (
    <div className="space-y-3 rounded-sp-btn border border-sp-line p-3 bg-sp-surface-lo">
      <div className="flex items-center gap-2">
        <Label className="text-xs sp-label">Topic</Label>
        <span className="font-mono text-sp-12 truncate" style={{ color: KAFKA_PINK }} title={topic}>
          {topic}
        </span>
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
          aria-label="Close topic inspector"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      {error && <div className="font-mono text-sp-12 text-red-400 break-all">{error}</div>}

      {/* Partition watermarks */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-xs sp-label">Partitions</Label>
          <span className="text-sp-11 text-sp-dim tabular-nums">
            ~{totalMessages.toLocaleString()} messages
          </span>
        </div>
        {partitions === null ? (
          <p className="text-xs text-sp-dim">Loading…</p>
        ) : partitions.length === 0 ? (
          <p className="text-xs text-sp-dim">No partitions.</p>
        ) : (
          <div className="overflow-hidden rounded-sp-btn border border-sp-line">
            <table className="w-full text-sp-11 font-mono tabular-nums">
              <thead className="text-sp-dim">
                <tr className="border-b border-sp-line">
                  <th className="px-2 py-1 text-left font-medium">Partition</th>
                  <th className="px-2 py-1 text-right font-medium">Low</th>
                  <th className="px-2 py-1 text-right font-medium">High</th>
                  <th className="px-2 py-1 text-right font-medium">Count</th>
                </tr>
              </thead>
              <tbody>
                {partitions.map((p) => (
                  <tr key={p.partition} className="border-b border-sp-line/60 last:border-0">
                    <td className="px-2 py-1" style={{ color: partitionColor(p.partition) }}>
                      P{p.partition}
                    </td>
                    <td className="px-2 py-1 text-right text-sp-muted">{p.low}</td>
                    <td className="px-2 py-1 text-right text-sp-text">{p.high}</td>
                    <td className="px-2 py-1 text-right text-sp-text">
                      {Number(p.count).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Topic config */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-xs sp-label">Config</Label>
          <div className="flex items-center gap-2">
            <Switch checked={showDefaults} onCheckedChange={setShowDefaults} />
            <Label className="text-sp-11 text-sp-dim">Show defaults</Label>
          </div>
        </div>
        {config === null ? (
          <p className="text-xs text-sp-dim">Loading…</p>
        ) : visibleConfig.length === 0 ? (
          <p className="text-xs text-sp-dim">
            {showDefaults ? 'No config.' : 'No non-default config — toggle "Show defaults".'}
          </p>
        ) : (
          <ScrollArea className="max-h-56">
            <ul className="space-y-1 pr-2">
              {visibleConfig.map((c) => (
                <li
                  key={c.name}
                  className="flex items-start justify-between gap-2 rounded-sp-btn border border-sp-line px-2 py-1"
                >
                  <span
                    className="font-mono text-sp-11 text-sp-muted break-all"
                    title={c.isDefault ? 'broker default' : c.source}
                  >
                    {c.name}
                    {c.isDefault && <span className="ml-1 text-sp-dim">(default)</span>}
                  </span>
                  <span className="font-mono text-sp-11 text-sp-text text-right break-all">
                    {c.isSensitive ? '••••••' : (c.value ?? '∅')}
                  </span>
                </li>
              ))}
            </ul>
          </ScrollArea>
        )}
      </div>
    </div>
  );
}
