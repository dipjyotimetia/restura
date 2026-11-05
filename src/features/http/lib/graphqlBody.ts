import { injectGraphQLBody } from '@shared/graphql/inject';
import { buildGraphQLWireRequest, graphqlEnvelopeFromBody } from '@shared/graphql/wire';
import type { ProxyBody } from '@shared/protocol/request-spec';
import type { HttpRequest } from '@/types';

export interface ShapedGraphQL {
  request: HttpRequest;
  /** The proxy body, built from already-resolved text (never resolved again). */
  body: ProxyBody;
  /** Query rows the wire builder added (GET), already resolved. */
  builtParams: ReadonlySet<HttpRequest['params'][number]>;
}

/**
 * Shape a `graphql` body for the wire with the shared builders, as the CLI
 * runner does (`cli/src/runner/executors/http.ts` `shapeGraphQL`): JSON-safe
 * `{{var}}` substitution in the document and variables, then the
 * `{query, variables, operationName}` envelope (POST) or URL params (GET), plus
 * the spec Accept / Content-Type. Throws for invalid variables JSON or a GET
 * that cannot carry the operation — nothing is sent. Undefined for any other body.
 */
export function shapeGraphQLBody(
  request: HttpRequest,
  resolve: (text: string) => string
): ShapedGraphQL | undefined {
  if (request.body.type !== 'graphql') return undefined;
  const envelope = graphqlEnvelopeFromBody(injectGraphQLBody(request.body, resolve));
  const wire = buildGraphQLWireRequest(request, envelope);
  if (!wire.ok) throw new Error(wire.error);
  const existing = new Set(request.params);
  const builtParams = new Set(wire.request.params.filter((p) => !existing.has(p)));
  const body: ProxyBody =
    wire.method === 'GET'
      ? { bodyType: 'none' }
      : {
          bodyType: 'json',
          ...(wire.request.body.raw !== undefined ? { data: wire.request.body.raw } : {}),
        };
  return { request: wire.request, body, builtParams };
}
