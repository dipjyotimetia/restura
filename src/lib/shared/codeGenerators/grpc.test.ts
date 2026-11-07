import { describe, expect, it } from 'vitest';
import { grpcCodeGenerators } from './index';

const base = {
  service: 'greet.v1.GreetService',
  method: 'Greet',
  message: '{"name":"it\'s me"}',
  metadata: { authorization: 'Bearer x', '': 'skipped' },
};

describe('grpcCodeGenerators', () => {
  it('grpcurl: plaintext for grpc://, quoted headers/body, default port', () => {
    expect(
      grpcCodeGenerators.grpcurl.generate({ ...base, url: 'grpc://localhost' })
    ).toMatchInlineSnapshot(`
        "grpcurl -plaintext \\
          -H 'authorization: Bearer x' \\
          -d '{"name":"it'\\''s me"}' \\
          'localhost:80' \\
          'greet.v1.GreetService/Greet'"
      `);
  });

  it('grpcurl: TLS for https:// and bare hosts', () => {
    const out = grpcCodeGenerators.grpcurl.generate({ ...base, url: 'api.example.com:8443' });
    expect(out).not.toContain('-plaintext');
    expect(out).toContain("'api.example.com:8443'");
    expect(
      grpcCodeGenerators.grpcurl.generate({ ...base, url: 'https://api.example.com/x' })
    ).toContain("'api.example.com:443'");
  });

  it('buf curl: builds the method URL, h2c for plaintext', () => {
    expect(
      grpcCodeGenerators.bufcurl.generate({ ...base, url: 'http://localhost:50051' })
    ).toMatchInlineSnapshot(`
        "buf curl --protocol grpc --http2-prior-knowledge \\
          -H 'authorization: Bearer x' \\
          -d '{"name":"it'\\''s me"}' \\
          'http://localhost:50051/greet.v1.GreetService/Greet'"
      `);
    const tls = grpcCodeGenerators.bufcurl.generate({
      ...base,
      message: '',
      url: 'grpcs://h:1',
    });
    expect(tls).toContain("-d '{}'");
    expect(tls).toContain("'https://h:1/greet.v1.GreetService/Greet'");
    expect(tls).not.toContain('prior-knowledge');
  });

  it('never lets a hostile service name escape the quotes', () => {
    const out = grpcCodeGenerators.grpcurl.generate({
      ...base,
      service: "x'; rm -rf / #",
      url: 'h:1',
    });
    expect(out).toContain("'x'\\''; rm -rf / #/Greet'");
  });
});

describe('grpcCodeGenerators — target parsing edge cases', () => {
  const plain = { service: 's.v1.S', method: 'M' };

  it('honours an explicit plaintext override over the URL scheme', () => {
    const forcedPlain = grpcCodeGenerators.grpcurl.generate({
      ...plain,
      url: 'https://secure.example.com',
      plaintext: true,
    });
    expect(forcedPlain).toContain('-plaintext');
    expect(forcedPlain).toContain("'secure.example.com:80'");

    const forcedTls = grpcCodeGenerators.bufcurl.generate({
      ...plain,
      url: 'grpc://localhost:50051',
      plaintext: false,
    });
    expect(forcedTls).not.toContain('prior-knowledge');
    expect(forcedTls).toContain("'https://localhost:50051/s.v1.S/M'");
  });

  it('defaults to localhost, no headers and an empty message when given only a scheme', () => {
    expect(
      grpcCodeGenerators.grpcurl.generate({ ...plain, url: 'grpc://' })
    ).toMatchInlineSnapshot(`
      "grpcurl -plaintext \\
        -d '{}' \\
        'localhost:80' \\
        's.v1.S/M'"
    `);
  });

  it('keeps bracketed IPv6 hosts and ignores path/query after the authority', () => {
    const out = grpcCodeGenerators.grpcurl.generate({
      ...plain,
      url: 'grpcs://[::1]:9443/ignored?x=1',
      message: '   ',
    });
    expect(out).toContain("'[::1]:9443'");
    expect(out).toContain("-d '{}'");
  });

  it('falls back to localhost when the URL has a port but no host', () => {
    const out = grpcCodeGenerators.grpcurl.generate({
      url: 'grpc://:50051',
      service: 'demo.v1.Greeter',
      method: 'SayHello',
      message: '{}',
    });
    expect(out).toContain('localhost:50051');
    expect(out).not.toContain(':50051:50051');
  });
});
