import type { SocketIOEvent, SocketIOEventFilter } from '../store/useSocketIOStore';

const searchableEventText = new WeakMap<SocketIOEvent, string>();

function searchText(event: SocketIOEvent): string {
  const cached = searchableEventText.get(event);
  if (cached !== undefined) return cached;

  let args = '';
  try {
    args = JSON.stringify(event.args);
  } catch {
    args = event.args.map(String).join(',');
  }
  const text = `${event.eventName} ${args}`.toLowerCase();
  searchableEventText.set(event, text);
  return text;
}

export function filterSocketIOEvents(
  events: SocketIOEvent[],
  eventFilter: SocketIOEventFilter,
  searchQuery: string
): SocketIOEvent[] {
  const query = searchQuery.trim().toLowerCase();
  if (eventFilter === 'all' && !query) return events;

  return events.filter(
    (event) =>
      (eventFilter === 'all' || event.direction === eventFilter) &&
      (!query || searchText(event).includes(query))
  );
}
