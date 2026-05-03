import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { ipcMain } from 'electron';
import * as path from 'path';

// Resolve proto files from @grpc/reflection package (bundled with the app)
// @grpc/reflection/build/src/index.js → build/src → ../proto = build/proto
const REFLECTION_PKG_PROTO_DIR = path.join(path.dirname(require.resolve('@grpc/reflection')), '../proto');

function getProtoPath(version: 'v1' | 'v1alpha'): string {
  return path.join(REFLECTION_PKG_PROTO_DIR, 'grpc', 'reflection', version, 'reflection.proto');
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

  const packageDef = protoLoader.loadSync(getProtoPath(version), PROTO_LOADER_OPTIONS);
  const pkg = grpc.loadPackageDefinition(packageDef) as Record<string, unknown>;

  const ns =
    version === 'v1'
      ? ((pkg['grpc'] as Record<string, unknown>)?.['reflection'] as Record<string, unknown>)?.['v1']
      : ((pkg['grpc'] as Record<string, unknown>)?.['reflection'] as Record<string, unknown>)?.['v1alpha'];

  const ClientConstructor = (ns as Record<string, unknown>)?.['ServerReflection'] as
    | grpc.ServiceClientConstructor
    | undefined;

  if (!ClientConstructor) {
    throw new Error(`Failed to load ServerReflection service for ${version}`);
  }

  clientCache.set(version, ClientConstructor);
  return ClientConstructor;
}

interface ReflectionIpcConfig {
  url: string;
  reflectionService: string;
  request: Record<string, unknown>;
  timeout?: number;
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

  const { address, useTls } = parseTargetAddress(url);
  const credentials = useTls ? grpc.credentials.createSsl() : grpc.credentials.createInsecure();

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
        ServerReflectionInfo: () => grpc.ClientDuplexStream<Record<string, unknown>, GrpcReflectionResponse>;
      }
    ).ServerReflectionInfo();

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
  ipcMain.handle('grpc:reflect', async (_event, config: unknown) => {
    const c = config as ReflectionIpcConfig;
    if (!c?.url || !c?.reflectionService || !c?.request) {
      throw new Error('Invalid reflection config: url, reflectionService, and request are required');
    }
    return sendReflectionRequest(c);
  });
}
