import { describe, expect, it } from 'vitest';
import { classifyProtocol } from '../protocol-classifier';
import type { CapturedHeader } from '../types';

const h = (name: string, value: string): CapturedHeader => ({ name, value });

describe('classifyProtocol', () => {
  it('classifies a plain JSON POST as rest', () => {
    const r = classifyProtocol({
      url: 'https://api.example.com/users',
      requestHeaders: [h('content-type', 'application/json')],
      requestBodyText: '{"name":"ada"}',
    });
    expect(r.protocol).toBe('rest');
  });

  it('classifies a GraphQL body by its shape', () => {
    const r = classifyProtocol({
      url: 'https://api.example.com/api',
      requestHeaders: [h('content-type', 'application/json')],
      requestBodyText: '{"query":"query GetUser { user { id } }","operationName":"GetUser"}',
    });
    expect(r.protocol).toBe('graphql');
    expect(r.graphql?.operationName).toBe('GetUser');
    expect(r.graphql?.operationType).toBe('query');
  });

  it('classifies by /graphql url even without a recognizable body', () => {
    const r = classifyProtocol({
      url: 'https://api.example.com/graphql',
      requestHeaders: [h('content-type', 'application/json')],
      requestBodyText: '{"query":"mutation { signup }"}',
    });
    expect(r.protocol).toBe('graphql');
    expect(r.graphql?.operationType).toBe('mutation');
  });

  it('classifies grpc-web by request content-type', () => {
    const r = classifyProtocol({
      url: 'https://api.example.com/pkg.Svc/Method',
      requestHeaders: [h('content-type', 'application/grpc-web+proto')],
    });
    expect(r.protocol).toBe('grpc-web');
  });

  // WebSocket/SSE classification is the normalizer's job (see cdp-normalizer
  // tests), not the request-time classifier's.
});
