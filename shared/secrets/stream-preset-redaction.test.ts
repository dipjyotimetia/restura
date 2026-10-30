import { describe, expect, it } from 'vitest';
import type { SocketIoRequest } from '../types';
import { countStreamPresetSecrets, redactStreamPreset } from './stream-preset-redaction';

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

describe('redactStreamPreset handshakeAuthJson', () => {
  const withJson = (handshakeAuthJson: string) =>
    ({ ...sio([]), handshakeAuthMode: 'json', handshakeAuthJson }) as SocketIoRequest;

  it('blanks every literal leaf at any depth, keeping keys and {{var}} references', () => {
    const out = redactStreamPreset(
      withJson(
        '{"token":"s3cr3t","ref":"{{token}}","user":{"id":7,"admin":true,"tags":["a","{{t}}"]},"n":null}'
      )
    );
    expect(JSON.parse(out.handshakeAuthJson!)).toEqual({
      token: '',
      ref: '{{token}}',
      user: { id: '', admin: '', tags: ['', '{{t}}'] },
      n: null,
    });
    expect(out.handshakeAuthJson).not.toContain('s3cr3t');
  });

  it('keeps bare {{var}} tokens outside strings and restores them verbatim', () => {
    const out = redactStreamPreset(withJson('{"id": {{uid}}, "pin": 1234, "s": "{{x}}"}'));
    expect(out.handshakeAuthJson).toContain('"id": {{uid}}');
    expect(out.handshakeAuthJson).toContain('"s": "{{x}}"');
    expect(out.handshakeAuthJson).not.toContain('1234');
  });

  it('does not mistake a {{...}} inside a literal string for a reference', () => {
    const out = redactStreamPreset(withJson('{"a":"pw {{x}} pw","b":"\\"{{y}}\\""}'));
    expect(JSON.parse(out.handshakeAuthJson!)).toEqual({ a: '', b: '' });
  });

  it('blanks unparseable text whole (fail closed)', () => {
    const out = redactStreamPreset(withJson('{"token": "s3cr3t"'));
    expect(out.handshakeAuthJson).toBe('');
  });

  it('leaves an absent payload absent and empty text empty', () => {
    expect('handshakeAuthJson' in redactStreamPreset(sio([]))).toBe(false);
    expect(redactStreamPreset(withJson('  ')).handshakeAuthJson).toBe('  ');
  });

  it('counts the leaves export redaction would blank', () => {
    expect(countStreamPresetSecrets(withJson('{"a":"x","b":{"c":1,"d":"{{v}}"},"e":{{w}}}'))).toBe(
      2
    );
    expect(countStreamPresetSecrets(withJson('not json'))).toBe(1);
    expect(countStreamPresetSecrets(withJson('{"a":"{{v}}"}'))).toBe(0);
  });
});
