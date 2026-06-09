#!/usr/bin/env node
/**
 * Standalone native gRPC server for manually testing the Restura DESKTOP app.
 *
 * Why this exists
 * ---------------
 * The echo Worker (echo.restura.dev) speaks Connect / gRPC-Web over HTTP/1.1.
 * That works for the WEB build, which proxies unary calls through the Worker
 * (`/api/grpc`) and streams server-side responses over connect-fetch.
 *
 * The DESKTOP build is different: it dials with `@grpc/grpc-js`, i.e. NATIVE
 * gRPC over HTTP/2 with binary framing and trailers. A Cloudflare Worker can't
 * serve that (no raw h2 server, no HTTP trailers for `grpc-status`), so the
 * desktop app can never reach echo.restura.dev — it fails with
 * `UNAVAILABLE: Protocol error`. Point the desktop app at THIS server instead:
 *
 *   npm run grpc:server                 # grpc://localhost:50051 (h2c, insecure)
 *   GRPC_PORT=9000 npm run grpc:server  # custom port
 *
 * Then in the desktop app's gRPC panel:
 *   URL      grpc://localhost:50051     (http://localhost:50051 also works)
 *   Service  echo.v1.EchoService
 *   Method   UnaryEcho | ServerStreamingEcho | ClientStreamingEcho | BidirectionalEcho
 *
 * It implements echo.v1.EchoService (all four streaming shapes) plus NATIVE
 * gRPC server reflection (v1 + v1alpha) so the app's "Discover" button works
 * without uploading a .proto.
 *
 * Behaviour mirrors the echo Worker (`echo/handlers/connect.ts`) so web and
 * desktop give identical results for the same input, with two additive testing
 * aids the Worker lacks:
 *   - error injection: send `message: "FAIL_NOT_FOUND"` (etc.) to get that code
 *   - metadata echo:   inbound `x-echo-*` request metadata is mirrored back as
 *                      response header metadata
 */
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const { ReflectionService } = require('@grpc/reflection');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(__dirname, '../e2e/mocks/proto/echo.proto');
const PORT = Number(process.env.GRPC_PORT) || 50051;
const HOST = process.env.GRPC_HOST || '127.0.0.1';

const COUNT_MIN = 1;
const COUNT_MAX = 10;

// Magic request-message values that drive specific gRPC error codes, so the
// desktop app's error rendering can be exercised without changing the proto.
// Same trigger strings as e2e/mocks/grpcServer.ts (FAIL_TRIGGERS).
const FAIL_TRIGGERS = {
  FAIL_NOT_FOUND: grpc.status.NOT_FOUND,
  FAIL_INVALID_ARGUMENT: grpc.status.INVALID_ARGUMENT,
  FAIL_PERMISSION_DENIED: grpc.status.PERMISSION_DENIED,
  FAIL_UNAUTHENTICATED: grpc.status.UNAUTHENTICATED,
  FAIL_RESOURCE_EXHAUSTED: grpc.status.RESOURCE_EXHAUSTED,
  FAIL_INTERNAL: grpc.status.INTERNAL,
  FAIL_UNAVAILABLE: grpc.status.UNAVAILABLE,
  FAIL_DEADLINE_EXCEEDED: grpc.status.DEADLINE_EXCEEDED,
  FAIL_UNIMPLEMENTED: grpc.status.UNIMPLEMENTED,
};

/** Return a grpc error object when `message` is a FAIL_* trigger, else null. */
function triggeredError(message) {
  const code = FAIL_TRIGGERS[message];
  if (code === undefined) return null;
  return { code, details: `mock-server triggered ${message}` };
}

/** Mirror inbound `x-echo-*` request metadata onto the response header metadata. */
function echoHeaderMetadata(call) {
  const header = new grpc.Metadata();
  const map = call.metadata.getMap();
  let mirrored = false;
  for (const key of Object.keys(map)) {
    if (key.toLowerCase().startsWith('x-echo-')) {
      header.set(key, String(map[key]));
      mirrored = true;
    }
  }
  if (mirrored) call.sendMetadata(header);
}

const impl = {
  UnaryEcho(call, callback) {
    echoHeaderMetadata(call);
    const err = triggeredError(call.request.message);
    if (err) return callback(err);
    callback(null, { message: `echo: ${call.request.message}`, index: 0 });
  },

  ServerStreamingEcho(call) {
    echoHeaderMetadata(call);
    const err = triggeredError(call.request.message);
    if (err) {
      call.emit('error', err);
      return;
    }
    const count = Math.min(Math.max(call.request.count || COUNT_MIN, COUNT_MIN), COUNT_MAX);
    for (let i = 0; i < count; i++) {
      call.write({ message: `echo: ${call.request.message}`, index: i });
    }
    call.end();
  },

  ClientStreamingEcho(call, callback) {
    const parts = [];
    let failed = null;
    call.on('data', (req) => {
      const err = triggeredError(req.message);
      if (err && !failed) failed = err;
      parts.push(req.message);
    });
    call.on('end', () => {
      if (failed) return callback(failed);
      echoHeaderMetadata(call);
      callback(null, { message_count: parts.length, concatenated: parts.join('|') });
    });
  },

  BidirectionalEcho(call) {
    echoHeaderMetadata(call);
    let index = 0;
    call.on('data', (req) => {
      const err = triggeredError(req.message);
      if (err) {
        call.emit('error', err);
        return;
      }
      call.write({ message: `echo: ${req.message}`, index: index++ });
    });
    call.on('end', () => call.end());
  },
};

function main() {
  const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(packageDefinition);

  const server = new grpc.Server();
  server.addService(proto.echo.v1.EchoService.service, impl);

  // Native gRPC server reflection (v1 + v1alpha) — drives the app's "Discover".
  new ReflectionService(packageDefinition).addToServer(server);

  server.bindAsync(`${HOST}:${PORT}`, grpc.ServerCredentials.createInsecure(), (err, port) => {
    if (err) {
      console.error(`Failed to bind gRPC server: ${err.message}`);
      process.exit(1);
    }
    console.log('');
    console.log('  Restura gRPC dev server (native gRPC over HTTP/2 / h2c)');
    console.log('  ──────────────────────────────────────────────────────');
    console.log(`  Listening   grpc://localhost:${port}   (http://localhost:${port} also works)`);
    console.log('  Service     echo.v1.EchoService');
    console.log('  Methods     UnaryEcho · ServerStreamingEcho · ClientStreamingEcho · BidirectionalEcho');
    console.log('  Reflection  enabled (v1 + v1alpha) — use the "Discover" button');
    console.log('');
    console.log('  Point the DESKTOP app here (echo.restura.dev is web-only for gRPC).');
    console.log('  Error codes: send message "FAIL_NOT_FOUND", "FAIL_UNAUTHENTICATED", etc.');
    console.log('  Press Ctrl+C to stop.');
    console.log('');
  });

  const shutdown = () => {
    server.tryShutdown((err) => {
      if (err) server.forceShutdown();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
