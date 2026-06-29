import type { CapturedExchange, CapturedProtocol } from '@shared/capture/types';

const PROTOCOL_COLOR: Record<CapturedProtocol, string> = {
  rest: '#127eee',
  graphql: '#e535ab',
  'grpc-web': '#2bb673',
  websocket: '#8b5cf6',
  sse: '#f59e0b',
};

function Badge({ protocol }: { protocol: CapturedProtocol }): React.JSX.Element {
  return (
    <span
      style={{
        background: PROTOCOL_COLOR[protocol],
        color: '#fff',
        borderRadius: 4,
        padding: '1px 6px',
        fontSize: 10,
        textTransform: 'uppercase',
      }}
    >
      {protocol}
    </span>
  );
}

export function RequestList({ exchanges }: { exchanges: CapturedExchange[] }): React.JSX.Element {
  if (exchanges.length === 0) {
    return <p style={{ color: '#777', fontSize: 12 }}>No requests captured yet.</p>;
  }
  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {exchanges.map((ex) => {
        let path = ex.url;
        try {
          path = new URL(ex.url).pathname;
        } catch {
          /* keep raw */
        }
        return (
          <li
            key={ex.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 4px',
              borderBottom: '1px solid #eee',
              fontSize: 12,
            }}
          >
            <Badge protocol={ex.protocol} />
            <strong style={{ minWidth: 38 }}>{ex.method}</strong>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{path}</span>
            <span style={{ color: '#999' }}>{ex.response?.status ?? ''}</span>
          </li>
        );
      })}
    </ul>
  );
}
