/**
 * Compile-time parity between the hand-written renderer-facing IPC payload
 * types (`electron/types/api/protocols/*`) and the Zod schemas that validate
 * them in the main process (`./*`).
 *
 * The types stay hand-written on purpose (each layer builds independently).
 * This file is the link that makes drift fail `tsc` instead of surfacing as a
 * runtime rejection. For each pair `Assert<PayloadParity<Payload, Schema>>`
 * requires BOTH:
 *   1. every payload the renderer can build is accepted by the schema's input
 *      type (`Payload` is assignable to `z.input<Schema>`), and
 *   2. every key the schema knows is nameable on the payload type (no schema
 *      field the renderer cannot send).
 *
 * Types only: nothing here exists at runtime. To cover a new payload add one
 * `export type` line at the bottom. A deliberate, documented difference gets a
 * `// drift:` comment and the third `PayloadParity` argument (schema-only keys).
 */
import type { z } from 'zod';
import type { ElectronAPI } from '../../../types/electron-api';
import type {
  GrpcRequestConfigSchema,
  HttpRequestConfigSchema,
  McpConnectSchema,
  McpRequestSchema,
  ReflectionIpcConfigSchema,
  SseConnectSchema,
  SseDisconnectSchema,
  WsConnectSchema,
  WsSendSchema,
} from './core';
import type { KafkaConnectSchema, KafkaProduceSchema, KafkaSubscribeSchema } from './kafka';
import type { McpStdioConnectSchema } from './mcp-stdio';
import type {
  MqttConnectSchema,
  MqttPublishSchema,
  MqttRequestSchema,
  MqttSubscribeSchema,
} from './mqtt';
import type { SocketIoConnectSchema, SocketIoEmitSchema, SocketIoReplyAckSchema } from './socketio';
import type { WsDisconnectSchema, WsPingSchema } from './websocket-control';

/** All keys across every member of a union (plain `keyof` keeps only common keys). */
type KeysOf<T> = T extends unknown ? keyof T : never;

/** Fail with a readable message instead of a bare `false`. */
export type PayloadParity<Payload, Schema extends z.ZodType, SchemaOnly extends string = never> = [
  Payload,
] extends [z.input<Schema>]
  ? [Exclude<KeysOf<z.input<Schema>>, KeysOf<Payload> | SchemaOnly>] extends [never]
    ? true
    : {
        error: 'schema field(s) the payload type cannot name';
        fields: Exclude<KeysOf<z.input<Schema>>, KeysOf<Payload> | SchemaOnly>;
      }
  : {
      error: 'payload type is not assignable to the schema input';
      payload: Payload;
    };

/** Constraint that makes a non-`true` parity result a compile error. */
export type Assert<T extends true> = T;

type Arg0<F> = F extends (arg: infer A, ...rest: never[]) => unknown ? A : never;

type Api = ElectronAPI;

// HTTP
export type HttpRequestParity = Assert<
  PayloadParity<Arg0<Api['http']['request']>, typeof HttpRequestConfigSchema>
>;

// gRPC
export type GrpcRequestParity = Assert<
  PayloadParity<Arg0<Api['grpc']['request']>, typeof GrpcRequestConfigSchema>
>;
export type GrpcStartStreamParity = Assert<
  PayloadParity<Arg0<Api['grpc']['startStream']>, typeof GrpcRequestConfigSchema>
>;
export type GrpcReflectParity = Assert<
  PayloadParity<Arg0<Api['grpc']['reflect']>, typeof ReflectionIpcConfigSchema>
>;

// SSE
export type SseConnectParity = Assert<
  PayloadParity<Arg0<Api['sse']['connect']>, typeof SseConnectSchema>
>;
export type SseDisconnectParity = Assert<
  PayloadParity<Arg0<Api['sse']['disconnect']>, typeof SseDisconnectSchema>
>;

// WebSocket
export type WsConnectParity = Assert<
  PayloadParity<Arg0<Api['websocket']['connect']>, typeof WsConnectSchema>
>;
export type WsSendParity = Assert<
  PayloadParity<Arg0<Api['websocket']['send']>, typeof WsSendSchema>
>;
export type WsPingParity = Assert<
  PayloadParity<Arg0<Api['websocket']['ping']>, typeof WsPingSchema>
>;
export type WsDisconnectParity = Assert<
  PayloadParity<Arg0<Api['websocket']['disconnect']>, typeof WsDisconnectSchema>
>;

// Socket.IO
export type SocketIoConnectParity = Assert<
  PayloadParity<Arg0<Api['socketio']['connect']>, typeof SocketIoConnectSchema>
>;
export type SocketIoEmitParity = Assert<
  PayloadParity<Arg0<Api['socketio']['emit']>, typeof SocketIoEmitSchema>
>;
export type SocketIoReplyAckParity = Assert<
  PayloadParity<Arg0<Api['socketio']['replyAck']>, typeof SocketIoReplyAckSchema>
>;

// Kafka
export type KafkaConnectParity = Assert<
  PayloadParity<Arg0<Api['kafka']['connect']>, typeof KafkaConnectSchema>
>;
export type KafkaProduceParity = Assert<
  PayloadParity<Arg0<Api['kafka']['produce']>, typeof KafkaProduceSchema>
>;
// drift: `fromBeginning` is a deprecated v1 field the schema still accepts
// (and ignores) during the renderer migration; the type deliberately omits it.
export type KafkaSubscribeParity = Assert<
  PayloadParity<Arg0<Api['kafka']['subscribe']>, typeof KafkaSubscribeSchema, 'fromBeginning'>
>;

// MQTT
export type MqttConnectParity = Assert<
  PayloadParity<Arg0<Api['mqtt']['connect']>, typeof MqttConnectSchema>
>;
export type MqttPublishParity = Assert<
  PayloadParity<Arg0<Api['mqtt']['publish']>, typeof MqttPublishSchema>
>;
export type MqttSubscribeParity = Assert<
  PayloadParity<Arg0<Api['mqtt']['subscribe']>, typeof MqttSubscribeSchema>
>;
export type MqttRequestParity = Assert<
  PayloadParity<Arg0<Api['mqtt']['request']>, typeof MqttRequestSchema>
>;

// MCP (connect payload is a union: HTTP/SSE variant + stdio variant)
export type McpConnectHttpParity = Assert<
  PayloadParity<
    Exclude<Arg0<Api['mcp']['connect']>, { transport: 'stdio' }>,
    typeof McpConnectSchema
  >
>;
export type McpConnectStdioParity = Assert<
  PayloadParity<
    Extract<Arg0<Api['mcp']['connect']>, { transport: 'stdio' }>,
    typeof McpStdioConnectSchema
  >
>;
export type McpRequestParity = Assert<
  PayloadParity<Arg0<Api['mcp']['request']>, typeof McpRequestSchema>
>;
