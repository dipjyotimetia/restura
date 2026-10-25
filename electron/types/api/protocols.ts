// Protocol IPC types for the preload bridge, split per protocol under
// `./protocols/` so concurrent protocol PRs don't collide in one file. Add new
// types to the matching protocol module; a type used by more than one protocol
// belongs in `./protocols/shared`. This barrel keeps every existing
// `./api/protocols` import path working.
export * from './protocols/grpc';
export * from './protocols/http';
export * from './protocols/kafka';
export * from './protocols/mcp';
export * from './protocols/mqtt';
export * from './protocols/shared';
export * from './protocols/socketio';
export * from './protocols/sse';
export * from './protocols/websocket';
