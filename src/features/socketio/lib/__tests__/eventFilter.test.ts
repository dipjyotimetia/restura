import { describe, expect, it } from 'vitest';
import type { SocketIOEvent } from '../../store/useSocketIOStore';
import { filterSocketIOEvents } from '../eventFilter';

const event = (
  id: string,
  direction: SocketIOEvent['direction'],
  args: unknown[]
): SocketIOEvent => ({
  id,
  direction,
  eventName: 'message',
  args,
  timestamp: 0,
});

describe('filterSocketIOEvents', () => {
  const events = [
    event('sent', 'sent', [{ text: 'alpha' }]),
    event('received', 'received', [{ text: 'bravo' }]),
  ];

  it('filters by direction and searches serialized event arguments', () => {
    expect(filterSocketIOEvents(events, 'received', 'bravo').map((item) => item.id)).toEqual([
      'received',
    ]);
  });

  it('returns the original list when no filter is active', () => {
    expect(filterSocketIOEvents(events, 'all', '')).toBe(events);
  });
});
