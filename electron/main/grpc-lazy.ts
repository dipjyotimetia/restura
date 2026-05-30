// Lazy, memoized accessors for the gRPC runtime modules, shared by
// grpc-handler.ts and grpc-reflection-handler.ts.
//
// @grpc/grpc-js and @grpc/proto-loader are heavy to evaluate. As static
// imports they ran during module load — pulled in by main.ts before
// app.whenReady — delaying window creation even for users who never touch
// gRPC. Loading them here on first use defers that cost, and a single shared
// cache means both handlers require each module at most once for the process.
//
// The getters are memoized and safe to call from the unit tests that exercise
// the gRPC helpers directly — require() resolves the module on demand.

let _grpc: typeof import('@grpc/grpc-js') | undefined;
let _protoLoader: typeof import('@grpc/proto-loader') | undefined;

export const getGrpc = (): typeof import('@grpc/grpc-js') => (_grpc ??= require('@grpc/grpc-js'));

export const getProtoLoader = (): typeof import('@grpc/proto-loader') =>
  (_protoLoader ??= require('@grpc/proto-loader'));
