import { create, type MessageInitShape, toBinary } from '@bufbuild/protobuf';
import { FileDescriptorProtoSchema } from '@bufbuild/protobuf/wkt';
import { createConnectRouter } from '@connectrpc/connect';
import { bytesToBase64 } from '@shared/protocol/crypto-utils';
import {
  EchoReplySchema,
  EchoService,
  EchoSummarySchema,
  file_echo,
} from '../../e2e/mocks/proto/gen/echo_pb';
import {
  ServerReflection,
  type ServerReflectionRequest,
  ServerReflectionResponseSchema,
} from '../../e2e/mocks/proto/gen/grpc/reflection/v1/reflection_pb';

const COUNT_MIN = 1;
const COUNT_MAX = 10;

// Service list and file descriptor bytes are derived from the generated
// descriptor so they stay in sync with the proto schema automatically.
const REFLECTION_SERVICES = file_echo.services.map((s) => ({ name: s.typeName }));

const FILE_DESCRIPTOR_BYTES = toBinary(FileDescriptorProtoSchema, file_echo.proto);
const FILE_DESCRIPTOR_B64 = bytesToBase64(FILE_DESCRIPTOR_BYTES);

// GRPC_STATUS_NOT_FOUND per the reflection protocol's ErrorResponse contract.
const NOT_FOUND = 5;

type ReflectionMessageResponseInit = MessageInitShape<
  typeof ServerReflectionResponseSchema
>['messageResponse'];

function reflectionMessageResponse(req: ServerReflectionRequest): ReflectionMessageResponseInit {
  switch (req.messageRequest.case) {
    case 'listServices':
      return { case: 'listServicesResponse', value: { service: REFLECTION_SERVICES } };
    case 'fileContainingSymbol':
    case 'fileByFilename':
      return {
        case: 'fileDescriptorResponse',
        value: { fileDescriptorProto: [FILE_DESCRIPTOR_BYTES] },
      };
    default:
      return {
        case: 'errorResponse',
        value: {
          errorCode: NOT_FOUND,
          errorMessage: `unsupported reflection request: ${req.messageRequest.case ?? 'empty'}`,
        },
      };
  }
}

const router = createConnectRouter()
  .service(EchoService, {
    async unaryEcho(req) {
      return create(EchoReplySchema, { message: `echo: ${req.message}`, index: 0 });
    },
    async *serverStreamingEcho(req) {
      const count = Math.min(Math.max(req.count, COUNT_MIN), COUNT_MAX);
      for (let i = 0; i < count; i++) {
        yield create(EchoReplySchema, { message: `echo: ${req.message}`, index: i });
      }
    },
    async clientStreamingEcho(reqs) {
      const parts: string[] = [];
      for await (const req of reqs) {
        parts.push(req.message);
      }
      return create(EchoSummarySchema, {
        messageCount: parts.length,
        concatenated: parts.join('|'),
      });
    },
    async *bidirectionalEcho(reqs) {
      let idx = 0;
      for await (const req of reqs) {
        yield create(EchoReplySchema, { message: `echo: ${req.message}`, index: idx++ });
      }
    },
  })
  // Real Connect-framed server reflection (v1) for clients that speak the
  // Connect protocol, e.g. the desktop app's Connect fallback transport.
  .service(ServerReflection, {
    async *serverReflectionInfo(reqs) {
      for await (const req of reqs) {
        yield create(ServerReflectionResponseSchema, {
          originalRequest: req,
          messageResponse: reflectionMessageResponse(req),
        });
      }
    },
  });

const REFLECTION_PATHS = new Set([
  '/grpc.reflection.v1.ServerReflection/ServerReflectionInfo',
  '/grpc.reflection.v1alpha.ServerReflection/ServerReflectionInfo',
]);

interface ReflectionBody {
  listServices?: string;
  fileContainingSymbol?: string;
  fileByFilename?: string;
}

function reflectionResponse(body: ReflectionBody): Record<string, unknown> {
  if ('listServices' in body) {
    return { listServicesResponse: { service: REFLECTION_SERVICES } };
  }
  if ('fileContainingSymbol' in body || 'fileByFilename' in body) {
    return { fileDescriptorResponse: { fileDescriptorProto: [FILE_DESCRIPTOR_B64] } };
  }
  return {};
}

async function* bodyToIterable(body: ReadableStream<Uint8Array> | null): AsyncIterable<Uint8Array> {
  if (!body) return;
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      yield value;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // already cancelled/closed
    }
  }
}

export async function connectEcho(req: Request): Promise<Response | null> {
  const url = new URL(req.url);

  // Plain-JSON reflection shim — the format the web Worker proxy sends
  // (worker/handlers/grpc-reflection.ts). Connect-framed reflection
  // (application/connect+*) falls through to the router's real
  // ServerReflection service below.
  const mediaType = (req.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (REFLECTION_PATHS.has(url.pathname) && mediaType === 'application/json') {
    if (req.method !== 'POST') return new Response(null, { status: 405 });
    let reflBody: ReflectionBody;
    try {
      reflBody = (await req.json()) as ReflectionBody;
    } catch {
      return Response.json({ error: 'invalid JSON' }, { status: 400 });
    }
    return Response.json(reflectionResponse(reflBody));
  }

  const handler = router.handlers.find((h) => h.requestPath === url.pathname);
  if (!handler) return null;

  const universalReq = {
    // Claim HTTP/2 so connect's universal handler accepts bidi-streaming
    // methods (ServerReflectionInfo); Cloudflare terminates h2 at the edge
    // and the Workers runtime abstracts the actual version away.
    httpVersion: '2',
    url: req.url,
    method: req.method,
    header: req.headers,
    body: bodyToIterable(req.body),
    signal: req.signal ?? new AbortController().signal,
  };

  const universalRes = await handler(universalReq);

  const headers = new Headers(universalRes.header);
  const responseBody = universalRes.body;
  if (!responseBody) {
    return new Response(null, { status: universalRes.status, headers });
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for await (const chunk of responseBody) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });

  return new Response(stream, { status: universalRes.status, headers });
}
