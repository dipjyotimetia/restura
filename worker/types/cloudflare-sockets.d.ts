declare module 'cloudflare:sockets' {
  interface SocketAddress {
    hostname: string;
    port: number;
  }
  interface Socket {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
    startTls(options?: { hostname?: string }): Socket;
    close(): Promise<void>;
  }
  export function connect(address: SocketAddress): Socket;
}
