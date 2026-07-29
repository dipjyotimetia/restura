import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { Duplex } from 'node:stream';
import { createEnterpriseProxyAgent } from '../security/enterprise-network';
import { buildTlsClientMaterial } from '../security/tls-material';
import type { GrpcTlsConfig } from './grpc-credentials';

class DeferredProxyDuplex extends Duplex {
  private target: Socket | undefined;
  private readonly writes: Array<{
    chunk: Buffer;
    encoding: BufferEncoding;
    callback: (error?: Error | null) => void;
  }> = [];

  override _read(): void {
    this.target?.resume();
  }

  override _write(
    chunk: Buffer,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    if (!this.target) {
      this.writes.push({ chunk: Buffer.from(chunk), encoding, callback });
      return;
    }
    this.target.write(chunk, encoding, callback);
  }

  attach(target: Socket): void {
    if (this.destroyed) {
      target.destroy();
      return;
    }
    this.target = target;
    target.on('data', (chunk) => {
      if (!this.push(chunk)) target.pause();
    });
    target.on('end', () => this.push(null));
    target.on('error', (error) => this.destroy(error));
    target.on('close', () => this.destroy());
    for (const write of this.writes.splice(0)) {
      target.write(write.chunk, write.encoding, write.callback);
    }
    target.resume();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.target?.destroy();
    for (const write of this.writes.splice(0)) write.callback(error);
    callback(error);
  }

  setTimeout(timeout: number, callback?: () => void): this {
    this.target?.setTimeout(timeout, callback);
    return this;
  }

  setNoDelay(noDelay?: boolean): this {
    this.target?.setNoDelay(noDelay);
    return this;
  }

  setKeepAlive(enable?: boolean, initialDelay?: number): this {
    this.target?.setKeepAlive(enable, initialDelay);
    return this;
  }
}

export function createGrpcProxyTunnel(url: string, tls: GrpcTlsConfig): Duplex {
  const proxy = tls.proxy;
  if (!proxy || !proxy.enabled) throw new Error('Managed gRPC proxy is unavailable');
  if (proxy.type !== 'http' && proxy.type !== 'https') {
    throw new Error(`Managed ${proxy.type.toUpperCase()} proxy is unsupported for gRPC`);
  }
  const parsed = new URL(url);
  const secureEndpoint = parsed.protocol === 'https:' || parsed.protocol === 'grpcs:';
  const port = parsed.port ? Number(parsed.port) : secureEndpoint ? 443 : 80;
  const deferred = new DeferredProxyDuplex();
  const request = new EventEmitter();
  let proxyStatus: number | undefined;
  request.once('proxyConnect', (response: { statusCode: number }) => {
    proxyStatus = response.statusCode;
  });
  const agent = createEnterpriseProxyAgent(proxy, tls);
  void agent
    .connect(request as never, {
      host: parsed.hostname,
      port,
      secureEndpoint,
      servername: parsed.hostname,
      rejectUnauthorized: tls.verifySsl !== false,
      ...(tls.minTlsVersion ? { minVersion: tls.minTlsVersion } : {}),
      ALPNProtocols: ['h2'],
      ...buildTlsClientMaterial(tls),
    })
    .then((socket) => {
      if (proxyStatus !== 200) {
        socket.destroy();
        throw new Error(`Managed proxy CONNECT failed with status ${proxyStatus ?? 'unknown'}`);
      }
      deferred.attach(socket);
    })
    .catch((error) => deferred.destroy(error instanceof Error ? error : new Error(String(error))));
  return deferred;
}
