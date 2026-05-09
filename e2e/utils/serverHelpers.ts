import type { IncomingMessage, ServerResponse } from 'node:http';

interface CloseableServer {
  listen: (port: number, host: string, cb: () => void) => unknown;
  address: () => { port: number } | string | null;
  close: (cb: (err?: Error) => void) => unknown;
  closeAllConnections?: () => void;
}

export async function bindLocalhost(server: CloseableServer): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('Failed to bind on 127.0.0.1');
  }
  return addr.port;
}

export function closeServer(server: CloseableServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.closeAllConnections?.();
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

export async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

export async function readJson<T = unknown>(req: IncomingMessage): Promise<T | null> {
  const text = await readBody(req);
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export interface CorsOptions {
  methods?: string;
  headers?: string;
  exposeHeaders?: string;
}

export function applyCors(res: ServerResponse, opts: CorsOptions = {}): void {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader(
    'access-control-allow-methods',
    opts.methods ?? 'GET,POST,PUT,DELETE,PATCH,OPTIONS,HEAD'
  );
  res.setHeader('access-control-allow-headers', opts.headers ?? '*');
  if (opts.exposeHeaders) {
    res.setHeader('access-control-expose-headers', opts.exposeHeaders);
  }
}

export function handlePreflight(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method !== 'OPTIONS') return false;
  res.writeHead(204);
  res.end();
  return true;
}
