import { v4 as uuidv4 } from 'uuid';
import type { ProtocolModule } from '@/features/registry/types';
import type { GrpcRequest, Response as ApiResponse } from '@/types';
import { makeProxyGrpcRequest, makeElectronGrpcRequest } from './lib/grpcClient';
import { isElectron } from '@/lib/shared/platform';

function createDefaultGrpcRequest(): GrpcRequest {
  return {
    id: uuidv4(),
    name: 'New gRPC Request',
    type: 'grpc',
    methodType: 'unary',
    url: '',
    service: '',
    method: '',
    metadata: [],
    message: '',
    auth: { type: 'none' },
  };
}

function defaultResolveVariables(
  text: string,
  vars: Record<string, string>
): string {
  let result = text;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replace(new RegExp(`{{${key}}}`, 'g'), value);
  }
  return result;
}

export const grpcProtocol: ProtocolModule = {
  id: 'grpc',
  label: 'gRPC',
  tabType: 'grpc',
  defaultRequest: createDefaultGrpcRequest,
  // Builder is intentionally undefined — Tasks 4.4/4.5 wire GrpcRequestBuilder.
  runRequest: async (request, ctx): Promise<ApiResponse> => {
    if (request.type !== 'grpc') {
      throw new Error(`gRPC protocol cannot run ${request.type} request`);
    }
    if (ctx.signal.aborted) {
      throw new DOMException('Request aborted', 'AbortError');
    }
    const variables = ctx.variables ?? {};
    const resolve = (text: string) => defaultResolveVariables(text, variables);

    // The Electron gRPC entry point requires proto file content, which the
    // registry contract doesn't surface today. Until Task 4.4+ extends the
    // contract (or routes through GrpcRequestBuilder), the registry path
    // uses the worker proxy in both web and Electron. The existing builder
    // continues to call makeElectronGrpcRequest directly with proto info.
    // TODO(task-4.4): plumb protoContent/protoFileName through ctx so
    //   Electron callers get full reflection support.
    if (isElectron()) {
      // Best-effort: try electron with empty proto; falls back to proxy on
      // failure. For now we keep behavior simple and predictable by always
      // using the proxy from the registry shim.
      void makeElectronGrpcRequest;
    }
    return await makeProxyGrpcRequest(request, resolve);
  },
};
