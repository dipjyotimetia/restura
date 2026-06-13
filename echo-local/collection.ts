// Generates an importable OpenCollection JSON pre-wired to the running stack:
// import it, click Send, it works — no env selection needed (URLs are literal).
//
// Scope is deliberate (see echo-local/README.md and the coverage matrix in the
// plan): only auth that round-trips cleanly through OpenCollection import is
// included (none/basic/bearer/apikey/awsv4). OAuth2 needs a grant-type the
// importer drops, and oauth1/wsse/digest/ntlm are lossy or unapplied by the
// client — those are documented in the manifest as manual steps instead.
//
// Builds a plain object (validated by the unit test against the real Zod schema
// + importOpenCollection) so this module stays free of any src/ import.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TEST_AUTH_FIXTURES } from '../e2e/mocks/authRoutes';
import { PORTS } from './ports';

type Json = Record<string, unknown>;

const { user: USER, aws: AWS } = TEST_AUTH_FIXTURES;

function httpItem(seq: number, name: string, method: string, url: string, auth?: Json): Json {
  return {
    info: { type: 'http', name, seq },
    http: { method, url, ...(auth ? { auth } : {}) },
  };
}

export function buildCollection(host = 'localhost'): Json {
  const http = `http://${host}:${PORTS.http}`;
  // The renderer's validateGrpcUrl requires an http(s):// scheme before it will
  // run Discover/reflection — a bare host:port is rejected and the request
  // can't execute. The IPC dial layer accepts http:// and speaks h2c, so this
  // is the form that actually works on import.
  const grpc = `http://${host}:${PORTS.grpc}`;
  const mcp = `http://${host}:${PORTS.mcp}/mcp`;

  const items: Json[] = [
    httpItem(1, 'HTTP echo (no auth)', 'GET', `${http}/json`),
    httpItem(2, 'HTTP Basic auth', 'GET', `${http}/basic-auth/${USER.username}/${USER.password}`, {
      type: 'basic',
      username: USER.username,
      password: USER.password,
    }),
    httpItem(3, 'HTTP Bearer token', 'GET', `${http}/bearer`, {
      type: 'bearer',
      token: 'echo-local-token',
    }),
    httpItem(4, 'HTTP API key (header)', 'GET', `${http}/api-key/header/X-API-Key/secret123`, {
      type: 'apikey',
      key: 'X-API-Key',
      value: 'secret123',
      placement: 'header',
    }),
    httpItem(5, 'HTTP API key (query)', 'GET', `${http}/api-key/query/api_key/secret123`, {
      type: 'apikey',
      key: 'api_key',
      value: 'secret123',
      placement: 'query',
    }),
    httpItem(6, 'HTTP AWS SigV4', 'GET', `${http}/aws/protected`, {
      type: 'awsv4',
      accessKeyId: AWS.accessKey,
      secretAccessKey: AWS.secretKey,
      region: AWS.region,
      service: AWS.service,
    }),
    {
      info: { type: 'graphql', name: 'GraphQL echo' },
      graphql: { url: `${http}/graphql`, query: 'query { __typename }' },
    },
    {
      info: { type: 'grpc', name: 'gRPC UnaryEcho' },
      grpc: {
        url: grpc,
        service: 'echo.v1.EchoService',
        method: 'UnaryEcho',
        methodType: 'unary',
        message: JSON.stringify({ message: 'hello', count: 3 }),
      },
    },
  ];

  return {
    opencollection: '1.0.0',
    info: { name: 'Restura Local Echo', version: '1.0.0' },
    bundled: true,
    items,
    extensions: {
      'x-restura-sse': [
        {
          info: { type: 'sse', name: 'SSE stream' },
          sse: { url: `${http}/stream/sse` },
        },
      ],
      'x-restura-mcp': [
        {
          info: { type: 'mcp', name: 'MCP echo' },
          mcp: { url: mcp, transport: 'streamable-http' },
        },
      ],
    },
  };
}

export function writeCollection(dir: string, host = 'localhost'): string {
  const path = join(dir, 'restura-echo-local.collection.json');
  writeFileSync(path, JSON.stringify(buildCollection(host), null, 2));
  return path;
}
