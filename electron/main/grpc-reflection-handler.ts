import type * as grpc from '@grpc/grpc-js';
import type * as protoLoader from '@grpc/proto-loader';
import { app, ipcMain } from 'electron';
import * as path from 'path';
import {
  createValidatedHandler,
  ReflectionIpcConfigSchema,
  type ReflectionIpcConfig,
} from './ipc-validators';
import { assertUrlHostnameSafe } from './dns-guard';
import { IPC } from '../shared/channels';
import { getGrpc, getProtoLoader } from './grpc-lazy';

// gRPC schemes accepted by the SSRF guard. Reflection URLs are routinely
// passed as grpc:// or grpcs:// in addition to http(s)://.
const GRPC_REFLECTION_ALLOWED_SCHEMES = ['http:', 'https:', 'grpc:', 'grpcs:'];

// In production, @grpc/reflection proto files are unpacked from the asar archive via asarUnpack.
// require.resolve() still points inside the asar, so we must redirect to the unpacked location.
function getReflectionProtoDir(): string {
  if (app.isPackaged) {
    return path.join(
      process.resourcesPath,
      'app.asar.unpacked',
      'node_modules',
      '@grpc',
      'reflection',
      'build',
      'proto'
    );
  }
  // In development, resolve directly from node_modules.
  // @grpc/reflection/build/src/index.js → build/src → ../proto = build/proto
  return path.join(path.dirname(require.resolve('@grpc/reflection')), '../proto');
}

function getProtoPath(version: 'v1' | 'v1alpha'): string {
  return path.join(getReflectionProtoDir(), 'grpc', 'reflection', version, 'reflection.proto');
}

const PROTO_LOADER_OPTIONS: protoLoader.Options = {
  keepCase: false,
  longs: String,
  enums: String,
  bytes: Buffer,
  defaults: false,
  oneofs: true,
};

// Cache client constructors — proto is loaded once per version per session
const clientCache = new Map<'v1' | 'v1alpha', grpc.ServiceClientConstructor>();

function loadServiceClient(version: 'v1' | 'v1alpha'): grpc.ServiceClientConstructor {
  const cached = clientCache.get(version);
  if (cached) return cached;

  const packageDef = getProtoLoader().loadSync(getProtoPath(version), PROTO_LOADER_OPTIONS);
  const pkg = getGrpc().loadPackageDefinition(packageDef) as Record<string, unknown>;

  const ns =
    version === 'v1'
      ? ((pkg['grpc'] as Record<string, unknown>)?.['reflection'] as Record<string, unknown>)?.[
          'v1'
        ]
      : ((pkg['grpc'] as Record<string, unknown>)?.['reflection'] as Record<string, unknown>)?.[
          'v1alpha'
        ];

  const ClientConstructor = (ns as Record<string, unknown>)?.['ServerReflection'] as
    | grpc.ServiceClientConstructor
    | undefined;

  if (!ClientConstructor) {
    throw new Error(`Failed to load ServerReflection service for ${version}`);
  }

  clientCache.set(version, ClientConstructor);
  return ClientConstructor;
}

interface RawReflectionResponse {
  listServicesResponse?: { service: Array<{ name: string }> };
  fileDescriptorResponse?: { fileDescriptorProto: string[] };
  errorResponse?: { errorCode: number; errorMessage: string };
}

interface GrpcReflectionResponse {
  listServicesResponse?: { service: Array<{ name: string }> };
  fileDescriptorResponse?: { fileDescriptorProto: Buffer[] };
  errorResponse?: { errorCode: number; errorMessage: string };
  [key: string]: unknown;
}

function parseTargetAddress(url: string): { address: string; useTls: boolean } {
  const withScheme = url.includes('://') ? url : `grpc://${url}`;
  const parsed = new URL(withScheme);
  const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
  return {
    address: `${parsed.hostname}:${port}`,
    useTls: parsed.protocol === 'https:',
  };
}

function toRawResponse(response: GrpcReflectionResponse): RawReflectionResponse {
  if (response.fileDescriptorResponse) {
    return {
      fileDescriptorResponse: {
        fileDescriptorProto: response.fileDescriptorResponse.fileDescriptorProto.map((buf) =>
          Buffer.isBuffer(buf) ? buf.toString('base64') : String(buf)
        ),
      },
    };
  }
  if (response.listServicesResponse) {
    return { listServicesResponse: response.listServicesResponse };
  }
  if (response.errorResponse) {
    return { errorResponse: response.errorResponse };
  }
  return {};
}

async function sendReflectionRequest(config: ReflectionIpcConfig): Promise<RawReflectionResponse> {
  const { url, reflectionService, request, timeout = 30000 } = config;
  const version: 'v1' | 'v1alpha' = reflectionService.includes('v1alpha') ? 'v1alpha' : 'v1';

  // SSRF pre-flight. `@grpc/grpc-js` resolves DNS inside its C++ binding and
  // exposes no connector hook, so this is best-effort against rebind — see
  // docs/adr/0006-electron-connection-and-dns-hardening.md.
  // `parseTargetAddress` accepts bare host:port; normalise to a URL string
  // first so `assertUrlHostnameSafe` can run its scheme + literal-IP policy.
  const urlWithScheme = url.includes('://') ? url : `grpc://${url}`;
  await assertUrlHostnameSafe(urlWithScheme, {
    allowLocalhost: true,
    allowedSchemes: GRPC_REFLECTION_ALLOWED_SCHEMES,
  });

  const { address, useTls } = parseTargetAddress(url);
  const grpcLib = getGrpc();
  const credentials = useTls
    ? grpcLib.credentials.createSsl()
    : grpcLib.credentials.createInsecure();

  const ClientConstructor = loadServiceClient(version);
  const client = new ClientConstructor(address, credentials, {
    'grpc.max_receive_message_length': 32 * 1024 * 1024,
    'grpc.max_send_message_length': 4 * 1024 * 1024,
  });

  return new Promise<RawReflectionResponse>((resolve, reject) => {
    let settled = false;

    const settle = (fn: () => void) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeoutId);
        client.close();
        fn();
      }
    };

    const timeoutId = setTimeout(
      () => settle(() => reject(new Error('Reflection request timed out'))),
      timeout
    );

    const call = (
      client as unknown as {
        ServerReflectionInfo: () => grpc.ClientDuplexStream<
          Record<string, unknown>,
          GrpcReflectionResponse
        >;
      }
    ).ServerReflectionInfo();

    // The gRPC Server Reflection protocol sends exactly one response per request message before
    // the client half-closes the stream. We resolve on the first data event and close immediately;
    // subsequent messages (which should not occur) are ignored by the settled guard.
    call.on('data', (response: GrpcReflectionResponse) => {
      settle(() => resolve(toRawResponse(response)));
    });

    call.on('error', (err: Error) => {
      settle(() => reject(err));
    });

    call.on('end', () => {
      settle(() => resolve({}));
    });

    call.write(request);
    call.end();
  });
}

export function registerGrpcReflectionIPC(): void {
  ipcMain.handle(
    IPC.grpc.reflect,
    createValidatedHandler(IPC.grpc.reflect, ReflectionIpcConfigSchema, sendReflectionRequest)
  );
}
