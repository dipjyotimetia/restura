import { CHANNEL_PREFIXES, IPC } from '../../shared/channels';
import type { ElectronAPI } from '../../types/electron-api';
import { channelEventBridge } from '../handlers/channel-event-bridge';
import { invoke, send } from './invoke';

type ProtocolApi = Pick<
  ElectronAPI,
  'http' | 'grpc' | 'websocket' | 'socketio' | 'sse' | 'mcp' | 'kafka' | 'mqtt'
>;

export const protocolApi: ProtocolApi = {
  http: {
    request: invoke<ElectronAPI['http']['request']>(IPC.http.request),
    cancel: invoke<ElectronAPI['http']['cancel']>(IPC.http.cancel),
  },
  grpc: {
    request: invoke<ElectronAPI['grpc']['request']>(IPC.grpc.request),
    reflect: invoke<ElectronAPI['grpc']['reflect']>(IPC.grpc.reflect),
    startStream: send<ElectronAPI['grpc']['startStream']>(IPC.grpc.startStream),
    sendMessage: send<ElectronAPI['grpc']['sendMessage']>(IPC.grpc.sendMessage),
    endStream: send<ElectronAPI['grpc']['endStream']>(IPC.grpc.endStream),
    cancelStream: send<ElectronAPI['grpc']['cancelStream']>(IPC.grpc.cancelStream),
    on: channelEventBridge(CHANNEL_PREFIXES.grpc).on,
    removeListener: channelEventBridge(CHANNEL_PREFIXES.grpc).removeListener,
  },
  websocket: {
    connect: invoke<ElectronAPI['websocket']['connect']>(IPC.ws.connect),
    send: invoke<ElectronAPI['websocket']['send']>(IPC.ws.send),
    disconnect: invoke<ElectronAPI['websocket']['disconnect']>(IPC.ws.disconnect),
    ...channelEventBridge(CHANNEL_PREFIXES.ws),
  },
  socketio: {
    connect: invoke<ElectronAPI['socketio']['connect']>(IPC.socketio.connect),
    emit: invoke<ElectronAPI['socketio']['emit']>(IPC.socketio.emit),
    disconnect: invoke<ElectronAPI['socketio']['disconnect']>(IPC.socketio.disconnect),
    ...channelEventBridge(CHANNEL_PREFIXES.socketio),
  },
  sse: {
    connect: invoke<ElectronAPI['sse']['connect']>(IPC.sse.connect),
    disconnect: invoke<ElectronAPI['sse']['disconnect']>(IPC.sse.disconnect),
    ...channelEventBridge(CHANNEL_PREFIXES.sse),
  },
  mcp: {
    connect: invoke<ElectronAPI['mcp']['connect']>(IPC.mcp.connect),
    request: invoke<ElectronAPI['mcp']['request']>(IPC.mcp.request),
    disconnect: invoke<ElectronAPI['mcp']['disconnect']>(IPC.mcp.disconnect),
    ...channelEventBridge(CHANNEL_PREFIXES.mcp),
  },
  kafka: {
    connect: invoke<ElectronAPI['kafka']['connect']>(IPC.kafka.connect),
    produce: invoke<ElectronAPI['kafka']['produce']>(IPC.kafka.produce),
    subscribe: invoke<ElectronAPI['kafka']['subscribe']>(IPC.kafka.subscribe),
    unsubscribe: invoke<ElectronAPI['kafka']['unsubscribe']>(IPC.kafka.unsubscribe),
    disconnect: invoke<ElectronAPI['kafka']['disconnect']>(IPC.kafka.disconnect),
    listTopics: invoke<ElectronAPI['kafka']['listTopics']>(IPC.kafka.listTopics),
    createTopic: invoke<ElectronAPI['kafka']['createTopic']>(IPC.kafka.createTopic),
    deleteTopic: invoke<ElectronAPI['kafka']['deleteTopic']>(IPC.kafka.deleteTopic),
    listGroups: invoke<ElectronAPI['kafka']['listGroups']>(IPC.kafka.listGroups),
    inspectTopic: invoke<ElectronAPI['kafka']['inspectTopic']>(IPC.kafka.inspectTopic),
    inspectGroup: invoke<ElectronAPI['kafka']['inspectGroup']>(IPC.kafka.inspectGroup),
    resetGroupOffsets: invoke<ElectronAPI['kafka']['resetGroupOffsets']>(
      IPC.kafka.resetGroupOffsets
    ),
    deleteGroup: invoke<ElectronAPI['kafka']['deleteGroup']>(IPC.kafka.deleteGroup),
    ...channelEventBridge(CHANNEL_PREFIXES.kafka),
  },
  mqtt: {
    connect: invoke<ElectronAPI['mqtt']['connect']>(IPC.mqtt.connect),
    publish: invoke<ElectronAPI['mqtt']['publish']>(IPC.mqtt.publish),
    subscribe: invoke<ElectronAPI['mqtt']['subscribe']>(IPC.mqtt.subscribe),
    unsubscribe: invoke<ElectronAPI['mqtt']['unsubscribe']>(IPC.mqtt.unsubscribe),
    disconnect: invoke<ElectronAPI['mqtt']['disconnect']>(IPC.mqtt.disconnect),
    ...channelEventBridge(CHANNEL_PREFIXES.mqtt),
  },
};
