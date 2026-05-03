import type { ReflectionResult, ReflectionServiceInfo } from '@/types';
import { GrpcStatusCode } from '@/types';
import { GrpcClientError, httpStatusToGrpcStatus } from '../grpcClient';
import { isElectron, workerAuthHeaders, workerBaseUrl } from '@/lib/shared/platform';
import {
  REFLECTION_SERVICE_V1,
  REFLECTION_SERVICE_V1_ALPHA,
  type RawReflectionResponse,
} from './types';
import { cacheMessageTypes, parseFileDescriptor } from './protoParser';
import { buildServiceInfo } from './serviceDiscovery';

export class GrpcReflectionClient {
  private baseUrl: string;
  private reflectionVersion: 'v1' | 'v1alpha' = 'v1';
  private timeout: number;

  constructor(baseUrl: string, timeout = 30000) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeout = timeout;
  }

  async discoverServices(): Promise<ReflectionResult> {
    try {
      let services: string[];
      try {
        services = await this.listServices(REFLECTION_SERVICE_V1);
        this.reflectionVersion = 'v1';
      } catch {
        services = await this.listServices(REFLECTION_SERVICE_V1_ALPHA);
        this.reflectionVersion = 'v1alpha';
      }

      const userServices = services.filter((s) => !s.startsWith('grpc.reflection.'));
      const serviceInfos: ReflectionServiceInfo[] = [];

      for (const serviceName of userServices) {
        try {
          serviceInfos.push(await this.getServiceInfo(serviceName));
        } catch (error) {
          console.warn(`Failed to get info for service ${serviceName}:`, error);
        }
      }

      return { success: true, services: serviceInfos, serverUrl: this.baseUrl, timestamp: Date.now() };
    } catch (error) {
      return {
        success: false,
        services: [],
        error: error instanceof Error ? error.message : 'Failed to discover services',
        serverUrl: this.baseUrl,
        timestamp: Date.now(),
      };
    }
  }

  private async listServices(reflectionServiceName: string): Promise<string[]> {
    const response = await this.sendReflectionRequest(reflectionServiceName, { listServices: '' });

    if (response.errorResponse) {
      throw new GrpcClientError(
        response.errorResponse.errorMessage,
        response.errorResponse.errorCode as GrpcStatusCode
      );
    }
    if (!response.listServicesResponse) {
      throw new GrpcClientError(
        'Invalid reflection response: missing listServicesResponse',
        GrpcStatusCode.INTERNAL
      );
    }

    return response.listServicesResponse.service.map((s) => s.name);
  }

  private async getServiceInfo(serviceName: string): Promise<ReflectionServiceInfo> {
    const reflectionServiceName =
      this.reflectionVersion === 'v1' ? REFLECTION_SERVICE_V1 : REFLECTION_SERVICE_V1_ALPHA;

    const response = await this.sendReflectionRequest(reflectionServiceName, {
      fileContainingSymbol: serviceName,
    });

    if (response.errorResponse) {
      throw new GrpcClientError(
        response.errorResponse.errorMessage,
        response.errorResponse.errorCode as GrpcStatusCode
      );
    }
    if (!response.fileDescriptorResponse) {
      throw new GrpcClientError(
        'Invalid reflection response: missing fileDescriptorResponse',
        GrpcStatusCode.INTERNAL
      );
    }

    const fileDescriptors = response.fileDescriptorResponse.fileDescriptorProto.map((encoded) => {
      const descriptor = parseFileDescriptor(encoded);
      cacheMessageTypes(descriptor);
      return descriptor;
    });

    for (const fd of fileDescriptors) {
      if (fd.service) {
        for (const svc of fd.service) {
          const fullName = fd.package ? `${fd.package}.${svc.name}` : svc.name || '';
          if (fullName === serviceName || svc.name === serviceName) {
            return buildServiceInfo(svc, fd.package || '');
          }
        }
      }
    }

    throw new GrpcClientError(
      `Service ${serviceName} not found in file descriptors`,
      GrpcStatusCode.NOT_FOUND
    );
  }

  private async sendReflectionRequest(
    reflectionServiceName: string,
    request: unknown
  ): Promise<RawReflectionResponse> {
    if (!isElectron()) {
      return this.sendReflectionRequestViaProxy(request);
    }

    // Electron: use native binary gRPC via main-process IPC
    try {
      const response = await window.electron!.grpc.reflect({
        url: this.baseUrl,
        reflectionService: reflectionServiceName,
        request: request as Record<string, unknown>,
        timeout: this.timeout,
      });
      return response as RawReflectionResponse;
    } catch (error) {
      if (error instanceof GrpcClientError) throw error;
      throw new GrpcClientError(
        `Reflection failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        GrpcStatusCode.UNAVAILABLE
      );
    }
  }

  private async sendReflectionRequestViaProxy(request: unknown): Promise<RawReflectionResponse> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(`${workerBaseUrl()}/api/grpc/reflection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...workerAuthHeaders() },
        body: JSON.stringify({ url: this.baseUrl, request, timeout: this.timeout }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({})) as { error?: string };
        throw new GrpcClientError(
          errorData.error || `Reflection request failed: ${response.statusText}`,
          httpStatusToGrpcStatus(response.status)
        );
      }

      const responseData = await response.json() as RawReflectionResponse & { error?: string };

      if (responseData.error) {
        throw new GrpcClientError(responseData.error, GrpcStatusCode.INTERNAL);
      }

      return responseData;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof GrpcClientError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new GrpcClientError('Reflection request timed out', GrpcStatusCode.DEADLINE_EXCEEDED);
      }
      throw new GrpcClientError(
        `Failed to connect to reflection service: ${error instanceof Error ? error.message : 'Unknown error'}`,
        GrpcStatusCode.UNAVAILABLE
      );
    }
  }
}
