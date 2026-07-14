/**
 * Parity between `GrpcSpec` (`shared/protocol/grpc-proxy.ts`) and its Zod
 * mirror `GrpcProxyRequestBodySchema` (`shared/protocol/grpc-schema.ts`), which
 * validates the `/api/grpc` body at the Worker boundary.
 *
 * (The renderer's `GrpcRequest` is intentionally NOT identical — it carries
 * `metadata` as `KeyValue[]` and `message` as a string, mapped to `GrpcSpec`'s
 * `Record`/`unknown` shapes by the gRPC client; that mapping is covered by the
 * grpc client's own tests.)
 */

import type { GrpcSpec } from '@shared/protocol/grpc-proxy';
import {
  type GrpcProxyRequestBody,
  GrpcProxyRequestBodySchema,
} from '@shared/protocol/grpc-schema';
import { describe, expect, it } from 'vitest';
import { type Equals, expectTypeEqual } from './helpers/typeEquality';

describe('GrpcSpec / GrpcProxyRequestBodySchema parity', () => {
  it('the spec type and the inferred schema type are identical (compile-time)', () => {
    expectTypeEqual<Equals<GrpcSpec, GrpcProxyRequestBody>>();
  });

  it('a representative GrpcSpec parses against the schema (runtime)', () => {
    const spec: GrpcSpec = {
      url: 'https://grpc.example.com',
      service: 'greet.v1.GreetService',
      method: 'SayHello',
      metadata: { authorization: 'Bearer x' },
      message: { name: 'world' },
      timeout: 30_000,
    };
    expect(GrpcProxyRequestBodySchema.safeParse(spec).success).toBe(true);
  });

  it('rejects a spec missing required fields (runtime)', () => {
    expect(GrpcProxyRequestBodySchema.safeParse({ url: 'https://x' }).success).toBe(false);
  });
});
