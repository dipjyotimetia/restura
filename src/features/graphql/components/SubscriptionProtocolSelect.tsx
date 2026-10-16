import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { GRAPHQL_SUBSCRIPTION_PROTOCOLS, type GraphQLSubscriptionProtocol } from '@/types';

export const SUBSCRIPTION_PROTOCOL_LABELS: Record<GraphQLSubscriptionProtocol, string> = {
  auto: 'Auto (negotiate WebSocket)',
  'graphql-transport-ws': 'graphql-transport-ws',
  'subscriptions-transport-ws': 'subscriptions-transport-ws (legacy Apollo)',
  'graphql-sse': 'graphql-sse (Server-Sent Events)',
};

interface SubscriptionProtocolSelectProps {
  value: GraphQLSubscriptionProtocol | undefined;
  onChange: (value: GraphQLSubscriptionProtocol) => void;
  disabled?: boolean;
}

/** Per-request subscription wire protocol picker (#889). */
export function SubscriptionProtocolSelect({
  value,
  onChange,
  disabled,
}: SubscriptionProtocolSelectProps) {
  return (
    <div className="flex items-center gap-2">
      <span className="sp-label">Protocol</span>
      <Select
        value={value ?? 'auto'}
        onValueChange={(v) => onChange(v as GraphQLSubscriptionProtocol)}
        {...(disabled !== undefined ? { disabled } : {})}
      >
        <SelectTrigger
          aria-label="Subscription protocol"
          className="h-7 w-72 bg-sp-surface-lo border-sp-line text-sp-12 font-mono"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {GRAPHQL_SUBSCRIPTION_PROTOCOLS.map((p) => (
            <SelectItem key={p} value={p}>
              {SUBSCRIPTION_PROTOCOL_LABELS[p]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
