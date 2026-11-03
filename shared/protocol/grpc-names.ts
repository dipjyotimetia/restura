/**
 * Protobuf identifier rules for the gRPC call path (`/{service}/{method}`),
 * shared by every harness: the Worker/self-host relays, the CLI, Electron and
 * the renderer's builder validation — so a name one accepts, all accept.
 *
 * protoc's tokenizer treats `_` as a letter, so an identifier is
 * `[A-Za-z_][A-Za-z0-9_]*`. Package segments may be any case (C# protos use
 * `Company.Orders`), a service may have no package at all, and method names
 * need not be PascalCase (`sayHello`, `Get_Item` are legal). The patterns also
 * keep the path safe to build: no `/`, no empty or dot-only segments.
 */

const IDENT = '[A-Za-z_][A-Za-z0-9_]*';

/** Fully-qualified service name: `pkg.sub.Service` or a package-less `Service`. */
export const GRPC_SERVICE_NAME_RE = new RegExp(`^${IDENT}(?:\\.${IDENT})*$`);

/** A method name (a single identifier). */
export const GRPC_METHOD_NAME_RE = new RegExp(`^${IDENT}$`);

export function isValidGrpcServiceName(name: string): boolean {
  return GRPC_SERVICE_NAME_RE.test(name);
}

export function isValidGrpcMethodName(name: string): boolean {
  return GRPC_METHOD_NAME_RE.test(name);
}
