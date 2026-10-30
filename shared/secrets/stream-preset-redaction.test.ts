import { describe, expect, it } from 'vitest';
import type { SocketIoRequest } from '../types';
import { redactStreamPreset } from './stream-preset-redaction';

function sio(values: string[]): SocketIoRequest {
  return {
    id: 's',
    name: 'Chat',
    type: 'socketio',
    url: 'https://chat.example.com',
    query: [],
    handshakeAuth: values.map((value, i) => ({
      id: String(i),
      key: `k${i}`,
      value,
      enabled: true,
    })),
  } as unknown as SocketIoRequest;
}

describe('redactStreamPreset handshakeAuth', () => {
  it('keeps {{var}}-only values and blanks literals', () => {
    const out = redactStreamPreset(
      sio(['{{token}}', ' {{a}} {{b}} ', '{{a}}{{b}}', 'secret', '{{a}}x'])
    );
    expect(out.handshakeAuth.map((r) => r.value)).toEqual([
      '{{token}}',
      ' {{a}} {{b}} ',
      '{{a}}{{b}}',
      '',
      '',
    ]);
  });

  it('classifies adversarial template runs in linear time (CodeQL js/redos)', () => {
    const evil = `{{}}${'\t{{}}'.repeat(5000)}\u0000`;
    const started = performance.now();
    const out = redactStreamPreset(sio([evil]));
    expect(performance.now() - started).toBeLessThan(500);
    expect(out.handshakeAuth[0]?.value).toBe('');
  });
});
