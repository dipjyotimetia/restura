import type { CapturedExchange, CapturedProtocol } from '@shared/capture/types';

function statusClass(status: number | undefined): string {
  if (status == null) return 'rc-row__status';
  const bucket = Math.floor(status / 100);
  if (bucket === 2) return 'rc-row__status rc-row__status--2xx';
  if (bucket === 3) return 'rc-row__status rc-row__status--3xx';
  if (bucket === 4) return 'rc-row__status rc-row__status--4xx';
  if (bucket === 5) return 'rc-row__status rc-row__status--5xx';
  return 'rc-row__status';
}

// Color comes from the `.rc-badge--<protocol>` rules in styles.css — CSS owns presentation.
function Badge({ protocol }: { protocol: CapturedProtocol }): React.JSX.Element {
  return <span className={`rc-badge rc-badge--${protocol}`}>{protocol}</span>;
}

export function RequestList({ exchanges }: { exchanges: CapturedExchange[] }): React.JSX.Element {
  if (exchanges.length === 0) {
    return (
      <div className="rc-empty">
        <svg
          className="rc-empty__icon"
          width="28"
          height="28"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
        </svg>
        <span className="rc-empty__title">No requests captured yet</span>
        <span className="rc-empty__hint">
          Start capture from the popup, then browse — matching traffic appears here.
        </span>
      </div>
    );
  }
  return (
    <ul className="rc-list">
      {exchanges.map((ex) => {
        let path = ex.url;
        try {
          path = new URL(ex.url).pathname;
        } catch {
          /* keep raw */
        }
        return (
          <li key={ex.id} className="rc-row">
            <Badge protocol={ex.protocol} />
            <span className="rc-row__method">{ex.method}</span>
            <span className="rc-row__path" title={ex.url}>
              {path}
            </span>
            <span className={statusClass(ex.response?.status)}>{ex.response?.status ?? ''}</span>
          </li>
        );
      })}
    </ul>
  );
}
