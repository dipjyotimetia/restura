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
 * desktop give identical results for the same input, plus the same testing
 * aids as the Connect mock the web e2e uses (`e2e/mocks/grpcServer.ts`), so a
 * desktop test can reach every error / metadata path the web suite reaches:
 *   - error injection: send `message: "FAIL_NOT_FOUND"` (etc.) to get that code;
 *                      `FAIL_WITH_DETAILS` returns FAILED_PRECONDITION with a
 *                      `google.rpc.Status` in `grpc-status-details-bin` whose
 *                      single detail is an `echo.v1.EchoReply` (#883)
 *   - metadata echo:   inbound `x-echo-*` request metadata is mirrored back as
 *                      response header metadata; every successful call ends
 *                      with an `x-echo-count` trailer (message count)
 *   - slow streams:    `message: "SLOW_<ms>:<body>"` on ServerStreamingEcho
 *                      waits <ms> before each reply so deadline / cancel paths
 *                      can be exercised
 *
 * `GRPC_PORT=0` binds an ephemeral port; the "Listening" line prints the real one.
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
// `GRPC_PORT=0` asks for an ephemeral port; unset, empty or non-numeric falls
// back to the documented default.
const requestedPort = Number(process.env.GRPC_PORT ?? '');
const PORT = process.env.GRPC_PORT && !Number.isNaN(requestedPort) ? requestedPort : 50051;
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

// --- minimal protobuf wire encoding for the `grpc-status-details-bin` trailer.
// Hand-rolled on purpose: the server is a plain .mjs with no generated code,
// and `google.rpc.Status` + `google.protobuf.Any` are three fields each.
function varint(n) {
  const out = [];
  let v = n >>> 0;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return Buffer.from(out);
}
function lengthDelimited(fieldNo, bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8');
  return Buffer.concat([varint((fieldNo << 3) | 2), varint(b.length), b]);
}
function varintField(fieldNo, n) {
  return Buffer.concat([varint(fieldNo << 3), varint(n)]);
}

/** `google.rpc.Status{code, message, details:[Any{echo.v1.EchoReply}]}` — the
 *  same detail the Connect mock attaches for FAIL_WITH_DETAILS. */
function statusDetailsBin(code, message) {
  const echoReply = Buffer.concat([lengthDelimited(1, 'detail'), varintField(2, 7)]);
  const any = Buffer.concat([
    lengthDelimited(1, 'type.googleapis.com/echo.v1.EchoReply'),
    lengthDelimited(2, echoReply),
  ]);
  return Buffer.concat([
    varintField(1, code),
    lengthDelimited(2, message),
    lengthDelimited(3, any),
  ]);
}

const FAIL_WITH_DETAILS = 'FAIL_WITH_DETAILS';

/** Return a grpc error object when `message` is a FAIL_* trigger, else null. */
function triggeredError(message) {
  if (message === FAIL_WITH_DETAILS) {
    const details = `mock-server triggered ${FAIL_WITH_DETAILS}`;
    const metadata = new grpc.Metadata();
    metadata.set(
      'grpc-status-details-bin',
      statusDetailsBin(grpc.status.FAILED_PRECONDITION, details)
    );
    return { code: grpc.status.FAILED_PRECONDITION, details, metadata };
  }
  const code = FAIL_TRIGGERS[message];
  if (code === undefined) return null;
  return { code, details: `mock-server triggered ${message}` };
}

/** Trailer carrying the number of messages the call produced. */
function countTrailer(count) {
  const trailer = new grpc.Metadata();
  trailer.set('x-echo-count', String(count));
  return trailer;
}

/** `SLOW_<ms>:<body>` → { delayMs, body }; anything else → { delayMs: 0, body }. */
function slowSpec(message) {
  const m = /^SLOW_(\d+):(.*)$/s.exec(message);
  if (!m) return { delayMs: 0, body: message };
  return { delayMs: Math.min(Number(m[1]), 5_000), body: m[2] };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    callback(null, { message: `echo: ${call.request.message}`, index: 0 }, countTrailer(1));
  },

  async ServerStreamingEcho(call) {
    echoHeaderMetadata(call);
    const err = triggeredError(call.request.message);
    if (err) {
      call.emit('error', err);
      return;
    }
    const { delayMs, body } = slowSpec(call.request.message);
    const count = Math.min(Math.max(call.request.count || COUNT_MIN, COUNT_MIN), COUNT_MAX);
    for (let i = 0; i < count; i++) {
      if (delayMs > 0) await sleep(delayMs);
      // Client went away (deadline / cancel) — stop producing.
      if (call.cancelled) return;
      call.write({ message: `echo: ${body}`, index: i });
    }
    call.end(countTrailer(count));
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
      callback(
        null,
        { message_count: parts.length, concatenated: parts.join('|') },
        countTrailer(parts.length)
      );
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
    call.on('end', () => call.end(countTrailer(index)));
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
  server.addService(/** @type {any} */ (proto).echo.v1.EchoService.service, impl);

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
    console.log(
      '  Methods     UnaryEcho · ServerStreamingEcho · ClientStreamingEcho · BidirectionalEcho'
    );
    console.log('  Reflection  enabled (v1 + v1alpha) — use the "Discover" button');
    console.log('');
    console.log('  Point the DESKTOP app here (echo.restura.dev is web-only for gRPC).');
    console.log('  Error codes: send message "FAIL_NOT_FOUND", "FAIL_UNAUTHENTICATED", etc.');
    console.log(
      '  Details:     "FAIL_WITH_DETAILS" → grpc-status-details-bin; "SLOW_<ms>:<body>" delays streams'
    );
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
