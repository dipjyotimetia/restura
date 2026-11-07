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
