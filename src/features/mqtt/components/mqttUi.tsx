import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { MqttQoS } from '@/features/mqtt/store/useMqttStore';

export const MQTT_GREEN = 'var(--color-proto-mqtt)';

const QOS_VALUES: MqttQoS[] = [0, 1, 2];

export function QosPill({ qos }: { qos: MqttQoS }) {
  const colors = [
    'var(--color-neutral)',
    'var(--color-method-put)',
    'var(--color-method-patch)',
  ] as const;
  const color = colors[qos];
  return (
    <span
      className="inline-flex items-center justify-center h-5 px-1.5 font-mono font-bold text-sp-9 rounded-sp-chip"
      style={{
        color,
        background: `color-mix(in srgb, ${color} 15%, transparent)`,
        border: `1px solid color-mix(in srgb, ${color} 25%, transparent)`,
      }}
    >
      Q{qos}
    </span>
  );
}

/** Compact 0/1/2 QoS picker. The publish view uses its own labelled variant. */
export function QosSelect({
  value,
  onChange,
  triggerClassName = 'h-8 text-xs',
}: {
  value: MqttQoS;
  onChange: (qos: MqttQoS) => void;
  triggerClassName?: string;
}) {
  return (
    <Select value={String(value)} onValueChange={(next) => onChange(Number(next) as MqttQoS)}>
      <SelectTrigger className={triggerClassName}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {QOS_VALUES.map((qos) => (
          <SelectItem key={qos} value={String(qos)}>
            {qos}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
