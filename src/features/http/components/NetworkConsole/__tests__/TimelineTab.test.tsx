import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emitStreamEvent, useStreamTimelineStore } from '@/store/useStreamTimelineStore';
import TimelineTab from '../TimelineTab';

const download = vi.hoisted(() => vi.fn());
vi.mock('@/lib/shared/console-export', () => ({ downloadExportFile: download }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function seed() {
  act(() => {
    emitStreamEvent({
      ts: 1_000,
      protocol: 'websocket',
      connectionId: 'ws-conn-1',
      direction: 'out',
      label: 'text',
      payload: '{"cmd":"start","id":7}',
    });
    emitStreamEvent({
      ts: 1_250,
      protocol: 'mqtt',
      connectionId: 'mqtt-conn-1',
      direction: 'in',
      label: 'devices/7',
      payload: 'started',
      meta: { qos: 1 },
    });
    emitStreamEvent({
      ts: 2_000,
      protocol: 'kafka',
      connectionId: 'kafka-conn-1',
      direction: 'system',
      kind: 'error',
      payload: 'broker down',
    });
    useStreamTimelineStore.getState().flush();
  });
}

const rows = () => screen.queryAllByTestId('timeline-row');

describe('TimelineTab', () => {
  beforeEach(() => {
    download.mockReset();
    useStreamTimelineStore.getState().clear();
    useStreamTimelineStore.getState().setPaused(false);
  });

  it('shows the empty state before any stream traffic', () => {
    render(<TimelineTab />);
    expect(screen.getByText('No stream events yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /jsonl/i })).toBeDisabled();
  });

  it('interleaves events from every protocol with relative timing', () => {
    seed();
    render(<TimelineTab />);
    expect(rows()).toHaveLength(3);
    expect(within(rows()[1]!).getByText('+250ms')).toBeInTheDocument();
    expect(within(rows()[2]!).getByText('+750ms')).toBeInTheDocument();
    expect(screen.getByText(/3\/3 events/)).toBeInTheDocument();
  });

  it('filters by protocol chips and connection', () => {
    seed();
    render(<TimelineTab />);
    fireEvent.click(screen.getByRole('button', { name: 'MQTT', pressed: false }));
    expect(rows()).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'WS', pressed: false }));
    expect(rows()).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(rows()).toHaveLength(3);
    fireEvent.change(screen.getByLabelText('Filter by connection'), {
      target: { value: 'kafka-conn-1' },
    });
    expect(rows()).toHaveLength(1);
  });

  it('searches by text, guarded regex and JSONPath', () => {
    seed();
    render(<TimelineTab />);
    const input = screen.getByLabelText('Search timeline');
    fireEvent.change(input, { target: { value: 'start' } });
    expect(rows()).toHaveLength(2);

    fireEvent.click(screen.getByRole('radio', { name: 'Regex' }));
    fireEvent.change(input, { target: { value: '(a+)+' } });
    expect(screen.getByRole('alert')).toHaveTextContent(/nested/i);
    expect(rows()).toHaveLength(0);
    fireEvent.change(input, { target: { value: '^broker' } });
    expect(rows()).toHaveLength(1);

    fireEvent.click(screen.getByRole('radio', { name: 'JSONPath' }));
    fireEvent.change(input, { target: { value: '$.cmd' } });
    expect(rows()).toHaveLength(1);
    fireEvent.change(input, { target: { value: '$.nope' } });
    expect(screen.getByText('No matching events')).toBeInTheDocument();
  });

  it('inspects an event and anchors relative timing to it', () => {
    seed();
    render(<TimelineTab />);
    fireEvent.click(rows()[1]!);
    expect(screen.getByText('devices/7', { selector: 'dd' })).toBeInTheDocument();
    expect(screen.getByText('qos')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /set anchor/i }));
    expect(within(rows()[0]!).getByText('-250ms')).toBeInTheDocument();
    expect(within(rows()[1]!).getByText('anchor')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /clear anchor/i }));
    expect(within(rows()[1]!).getByText('+250ms')).toBeInTheDocument();
    fireEvent.keyDown(rows()[2]!, { key: 'Enter' });
    expect(screen.getByText('broker down', { selector: 'pre' })).toBeInTheDocument();
  });

  it('exports the filtered events as JSONL', () => {
    seed();
    render(<TimelineTab />);
    fireEvent.click(screen.getByRole('button', { name: 'Kafka', pressed: false }));
    fireEvent.click(screen.getByRole('button', { name: /jsonl/i }));
    expect(download).toHaveBeenCalledTimes(1);
    const file = download.mock.calls[0]![0] as { filename: string; contents: string };
    expect(file.filename).toMatch(/\.jsonl$/);
    const lines = file.contents.trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ protocol: 'kafka', kind: 'error' });
  });

  it('protocol chips collapse back to All when none or every protocol is selected', () => {
    seed();
    render(<TimelineTab />);
    const mqtt = () => screen.getByRole('button', { name: 'MQTT' });
    fireEvent.click(mqtt());
    expect(rows()).toHaveLength(1);
    fireEvent.click(mqtt());
    expect(rows()).toHaveLength(3);
    for (const name of ['WS', 'SIO', 'SSE', 'Kafka', 'MQTT']) {
      fireEvent.click(screen.getByRole('button', { name }));
    }
    // Selecting every protocol is the same as All — no chip stays pressed.
    expect(screen.getByRole('button', { name: 'MQTT' })).toHaveAttribute('aria-pressed', 'false');
    expect(rows()).toHaveLength(3);
  });

  it('caps rendered rows, previews long payloads and shows eviction and truncation', () => {
    act(() => {
      for (let i = 0; i < 505; i++) {
        emitStreamEvent({
          ts: i,
          protocol: 'sse',
          connectionId: 's',
          direction: 'in',
          payload: i === 504 ? 'L'.repeat(70 * 1024) : i === 503 ? '' : `e${i}`,
        });
      }
      useStreamTimelineStore.getState().flush();
      useStreamTimelineStore.setState({ evicted: 12 });
    });
    render(<TimelineTab />);
    expect(rows()).toHaveLength(500);
    expect(screen.getByText(/Showing the latest 500 of 505/)).toBeInTheDocument();
    expect(screen.getByText(/12 evicted/)).toBeInTheDocument();
    expect(within(rows()[498]!).getByText('(empty)')).toBeInTheDocument();
    expect(within(rows()[499]!).getByText(/L+…$/)).toBeInTheDocument();

    fireEvent.keyDown(rows()[498]!, { key: 'a' });
    expect(screen.getByText('Select an event to inspect it')).toBeInTheDocument();
    fireEvent.keyDown(rows()[498]!, { key: ' ' });
    expect(screen.getByText('(empty payload)')).toBeInTheDocument();
    fireEvent.click(rows()[499]!);
    expect(screen.getByText('Preview truncated at 64 KB.')).toBeInTheDocument();
  });

  it('toggles pause', () => {
    render(<TimelineTab />);
    fireEvent.click(screen.getByRole('button', { name: 'Pause timeline capture' }));
    expect(useStreamTimelineStore.getState().paused).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Resume timeline capture' }));
    expect(useStreamTimelineStore.getState().paused).toBe(false);
  });
});
