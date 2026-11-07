/**
 * Web reflection must resolve the import closure too: the descriptors feed
 * `registryFromDescriptors` on web (Connect server-streaming, gRPC-Web, the
 * saved snapshot the CLI replays), and that throws on a missing non-WKT import.
 */
import { descriptorsFromProtoFiles, registryFromDescriptors } from '@shared/protocol/grpc-registry';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isElectron } from '@/lib/shared/platform';
import { GrpcReflectionClient } from '../reflectionClient';

const COMMON = {
  path: 'acme/common/v1/common.proto',
  content: `syntax = "proto3";
package acme.common.v1;
message Money { string currency = 1; int64 units = 2; }
`,
};
const BILLING = {
  path: 'acme/billing/v1/billing.proto',
  content: `syntax = "proto3";
package acme.billing.v1;
import "acme/common/v1/common.proto";
message ChargeRequest { acme.common.v1.Money amount = 1; }
message ChargeResponse { string id = 1; }
service BillingService { rpc Charge(ChargeRequest) returns (ChargeResponse); }
`,
};

const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GrpcReflectionClient import closure (web)', () => {
  it('fetches a dependency the server did not bundle via fileByFilename', async () => {
    expect(isElectron()).toBe(false);
    const [commonB64, billingB64] = (() => {
      const all = descriptorsFromProtoFiles([COMMON, BILLING]);
      // Order-independent: pick each file by content.
      const common = all.find(
        (d) =>
          atob(d).includes('acme/common/v1/common.proto') && !atob(d).includes('BillingService')
      );
      const billing = all.find((d) => atob(d).includes('BillingService'));
      return [common!, billing!];
    })();

    const requests: Record<string, unknown>[] = [];
    mockFetch.mockImplementation(async (_url: string, init: RequestInit) => {
      const { request } = JSON.parse(String(init.body)) as { request: Record<string, string> };
      requests.push(request);
      let payload: unknown;
      if ('listServices' in request) {
        payload = {
          listServicesResponse: { service: [{ name: 'acme.billing.v1.BillingService' }] },
        };
      } else if (request.fileContainingSymbol === 'acme.billing.v1.BillingService') {
        // Only the requested file — its import is NOT bundled.
        payload = { fileDescriptorResponse: { fileDescriptorProto: [billingB64] } };
      } else if (request.fileByFilename === COMMON.path) {
        payload = { fileDescriptorResponse: { fileDescriptorProto: [commonB64] } };
      } else {
        payload = { errorResponse: { errorCode: 5, errorMessage: 'not found' } };
      }
      return { ok: true, json: async () => payload };
    });

    const result = await new GrpcReflectionClient('https://grpc.example.com').discoverServices();

    expect(result.success).toBe(true);
    expect(requests).toContainEqual({ fileByFilename: COMMON.path });
    const descriptors = result.services[0]?.descriptors ?? [];
    expect(descriptors).toHaveLength(2);
    // The web consumers can now build a registry (missing import used to throw).
    const registry = registryFromDescriptors(descriptors);
    expect(registry.getService('acme.billing.v1.BillingService')).toBeDefined();
    expect(registry.getMessage('acme.common.v1.Money')).toBeDefined();
  });
});
