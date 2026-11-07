import { escapeShell } from './types';

export interface GrpcGenerateOptions {
  /** Server URL as typed: `grpc://`, `grpcs://`, `http(s)://` or a bare `host:port`. */
  url: string;
  /** Fully-qualified service, e.g. `greet.v1.GreetService`. */
  service: string;
  method: string;
  /** Request message as JSON text. */
  message?: string;
  metadata?: Record<string, string>;
  /** Force plaintext / TLS; defaults from the URL scheme (bare host → TLS). */
  plaintext?: boolean;
}

interface Target {
  host: string;
  port: string;
  plaintext: boolean;
}

function parseTarget(url: string, override?: boolean): Target {
  const trimmed = url.trim();
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed)?.[1]?.toLowerCase();
  const rest = scheme ? trimmed.slice(scheme.length + 3) : trimmed;
  const authority = rest.split(/[/?#]/, 1)[0] ?? '';
  const plaintext = override ?? (scheme === 'http' || scheme === 'grpc');
  // [v6]:port | host:port | host
  const m = /^(\[[^\]]*\]|[^:]*)(?::(\d+))?$/.exec(authority);
  // No match (malformed) keeps the raw authority; an empty host means localhost.
  const host = m ? m[1] || 'localhost' : authority || 'localhost';
  const port = m?.[2] ?? (plaintext ? '80' : '443');
  return { host, port, plaintext };
}

const headerFlags = (metadata: Record<string, string> | undefined): string =>
  Object.entries(metadata ?? {})
    .filter(([key]) => key)
    .map(([key, value]) => ` \\\n  -H ${escapeShell(`${key}: ${value}`)}`)
    .join('');

const messageBody = (message: string | undefined): string => {
  const text = message?.trim();
  return text ? text : '{}';
};

export const generateGrpcurl = (options: GrpcGenerateOptions): string => {
  const target = parseTarget(options.url, options.plaintext);
  let cmd = 'grpcurl';
  if (target.plaintext) cmd += ' -plaintext';
  cmd += headerFlags(options.metadata);
  cmd += ` \\\n  -d ${escapeShell(messageBody(options.message))}`;
  cmd += ` \\\n  ${escapeShell(`${target.host}:${target.port}`)}`;
  cmd += ` \\\n  ${escapeShell(`${options.service}/${options.method}`)}`;
  return cmd;
};

export const generateBufCurl = (options: GrpcGenerateOptions): string => {
  const target = parseTarget(options.url, options.plaintext);
  const base = `${target.plaintext ? 'http' : 'https'}://${target.host}:${target.port}`;
  let cmd = 'buf curl --protocol grpc';
  // Plaintext gRPC is h2c: tell buf to skip the HTTP/1.1 upgrade dance.
  if (target.plaintext) cmd += ' --http2-prior-knowledge';
  cmd += headerFlags(options.metadata);
  cmd += ` \\\n  -d ${escapeShell(messageBody(options.message))}`;
  cmd += ` \\\n  ${escapeShell(`${base}/${options.service}/${options.method}`)}`;
  return cmd;
};

export const grpcCodeGenerators = {
  grpcurl: { name: 'grpcurl', generate: generateGrpcurl },
  bufcurl: { name: 'buf curl', generate: generateBufCurl },
};

export type GrpcCodeGeneratorType = keyof typeof grpcCodeGenerators;
