import { v4 as uuid } from 'uuid';
import { kafkaEntryToInternal, mqttEntryToInternal } from '../../opencollection/broker-items';
import { mcpStdioFromOC } from '../../opencollection/mcp-stdio-extension';
import type { KafkaRequest, McpRequest, MqttRequest } from '../../types';
import { arr, description, isObj, type ParseContext, type Raw, str } from './common';
import {
  convertAuth,
  extractScripts,
  keepBagOnlyAuth,
  keepExamples,
  keepSchema,
  keepScripts,
  keepSettingsRest,
  rows,
  scrub,
} from './parse-v3-shared';
import type { PostmanSidecar } from './sidecar';

/** Postman v3 MQTT / Kafka (connection presets) and MCP converters (#1200). */

// ── MQTT / Kafka (connection presets) ───────────────────────────────────────

export function keepBrokerAuth(raw: Raw, name: string, sidecar: PostmanSidecar, ctx: ParseContext) {
  // Presets carry no credentials (shared/types/broker.ts): any auth is reported.
  if (isObj(raw.auth) && raw.auth.type !== 'noauth') {
    keepBagOnlyAuth(raw, sidecar);
    ctx.report.unsupportedAuth(str(raw.auth.type), name);
  }
}

export function keepLeftovers(
  leftovers: Raw,
  name: string,
  sidecar: PostmanSidecar,
  ctx: ParseContext
): void {
  if (Object.keys(leftovers).length === 0) return;
  sidecar.leftovers = scrub(leftovers);
  ctx.report.unmodelled('broker-leftovers', name);
}

export const MQTT_MAPPED_SETTINGS = new Set([
  'keepAlive',
  'cleanSession',
  'autoReconnect',
  'connectionTimeout',
]);

export function convertMqtt(raw: Raw, name: string, sidecar: PostmanSidecar, ctx: ParseContext) {
  const settings = isObj(raw.settings) ? raw.settings : {};
  const messages = arr(raw.messages).filter(isObj);
  const topics = arr(raw.topics).filter(isObj);
  const subscribe = topics.find((t) => t.subscribe !== false) ?? topics[0];
  const lastWill = isObj(raw.lastWill) ? raw.lastWill : undefined;
  const publish = (m: Raw) => ({
    topic: m.topic,
    payload: m.content,
    qos: m.qos,
    retain: m.retain,
  });
  keepBrokerAuth(raw, name, sidecar, ctx);
  keepExamples(raw, name, sidecar, ctx);
  const leftovers: Raw = {};
  const otherTopics = topics.filter((t) => t !== subscribe);
  if (otherTopics.length > 0) leftovers.topics = otherTopics;
  const unmappedSettings = Object.fromEntries(
    Object.entries(settings).filter(([k]) => !MQTT_MAPPED_SETTINGS.has(k))
  );
  if (Object.keys(unmappedSettings).length > 0) leftovers.settings = unmappedSettings;
  if (raw.properties !== undefined) leftovers.properties = raw.properties;
  keepLeftovers(leftovers, name, sidecar, ctx);
  const req: MqttRequest = mqttEntryToInternal({
    info: { name, description: description(raw.description) },
    mqtt: {
      connection: {
        brokerUrl: raw.url,
        clientId: raw.clientId,
        protocolVersion: raw.version,
        keepalive: settings.keepAlive,
        cleanStart: settings.cleanSession,
        autoReconnect: settings.autoReconnect,
        connectTimeout: settings.connectionTimeout,
        ...(lastWill
          ? {
              lwt: {
                topic: lastWill.topic,
                payload: lastWill.payload,
                qos: lastWill.qos,
                retain: lastWill.retain,
              },
            }
          : {}),
      },
      publish: messages[0] ? publish(messages[0]) : {},
      subscribe: subscribe ? { topicFilter: subscribe.name, qos: subscribe.qos } : {},
      templates: messages.slice(1).map((m) => ({ name: m.name, ...publish(m) })),
    },
  });
  return { req, inherits: false };
}

export const KAFKA_ACKS: Record<string, 0 | 1 | -1> = { none: 0, leader: 1, all: -1 };
export const KAFKA_ENCODINGS: Record<string, string> = {
  text: 'utf8',
  json: 'json',
  base64: 'base64',
};

export function convertKafka(raw: Raw, name: string, sidecar: PostmanSidecar, ctx: ParseContext) {
  const settings = isObj(raw.settings) ? raw.settings : {};
  const messages = arr(raw.messages).filter(isObj);
  const first = messages[0];
  const content = (c: unknown) => (isObj(c) ? c : {});
  const consumer = raw.mode === 'consumer';
  const start = isObj(raw.startPosition) ? str(raw.startPosition.type) : '';
  keepBrokerAuth(raw, name, sidecar, ctx);
  keepSchema(raw, name, sidecar, ctx);
  // Kafka presets have no script slots: every script is kept and reported.
  const scripts = arr(raw.scripts);
  if (scripts.length > 0) keepScripts(scripts, name, sidecar, ctx);
  const leftovers: Raw = {};
  if (consumer && raw.stopAfter !== undefined) leftovers.stopAfter = raw.stopAfter;
  if (messages.length > 1) leftovers.messages = messages.slice(1);
  keepLeftovers(leftovers, name, sidecar, ctx);
  if (settings.strictSSL === false) {
    ctx.report.securityDowngrade('strictSSL', name, 'TLS certificate verification is off');
  }
  const req: KafkaRequest = kafkaEntryToInternal({
    info: { name, description: description(raw.description) },
    kafka: {
      connection: {
        bootstrapBrokers: arr(raw.url),
        securityProtocol: settings.secureConnection === true ? 'SSL' : 'PLAINTEXT',
        acks: KAFKA_ACKS[str(raw.acknowledgements)],
        compression: settings.compression,
        ...(settings.strictSSL === false ? { tls: { rejectUnauthorized: false } } : {}),
      },
      produce: first
        ? {
            topic: first.topic,
            key: content(first.key).content,
            keyEncoding: KAFKA_ENCODINGS[str(content(first.key).contentType)],
            value: content(first.value).content,
            valueEncoding: KAFKA_ENCODINGS[str(content(first.value).contentType)],
            headers: arr(first.headers)
              .filter(isObj)
              .map((h) => ({ name: h.key, value: h.value, enabled: h.disabled !== true })),
            partition: first.partition,
          }
        : {},
      consume: {
        topics: consumer
          ? arr(raw.topics)
              .filter((t): t is Raw => isObj(t) && t.disabled !== true)
              .map((t) => t.name)
          : [],
        mode: start === 'beginning' ? 'earliest' : start === 'end' ? 'latest' : start || undefined,
      },
    },
  });
  return { req, inherits: false };
}

// ── MCP ─────────────────────────────────────────────────────────────────────

/** Split a command line into argv (whitespace, single / double quotes). No shell. */
export function splitCommandLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else cur += ch;
  }
  if (has || cur) out.push(cur);
  return out;
}

/** Env vars that make a launched process load attacker-chosen code. */
export const LOADER_ENV =
  /^(NODE_OPTIONS|LD_PRELOAD|LD_LIBRARY_PATH|DYLD_.*|PYTHONSTARTUP|PYTHONPATH)$/;

export function stdioWarning(argv: string[], envNames: string[]): string {
  const parts = [`argv ${JSON.stringify(argv).slice(0, 300)}`];
  if (envNames.length > 0) parts.push(`env names ${JSON.stringify(envNames).slice(0, 200)}`);
  const loaders = envNames.filter((n) => LOADER_ENV.test(n));
  if (loaders.length > 0) {
    parts.push(`code-loading (preload) variables ${JSON.stringify(loaders)} — review before use`);
  }
  return parts.join('; ');
}

export function convertMcp(raw: Raw, name: string, sidecar: PostmanSidecar, ctx: ParseContext) {
  const authOut = convertAuth(raw.auth, name, sidecar, ctx);
  const scripts = extractScripts(raw.scripts, name, sidecar, ctx);
  const settings = isObj(raw.settings) ? raw.settings : {};
  const req: McpRequest = {
    id: uuid(),
    name,
    type: 'mcp',
    url: '',
    transport: 'streamable-http',
    headers: [],
    auth: authOut.auth ?? { type: 'none' },
    preRequestScript: scripts.preRequestScript,
    testScript: scripts.testScript,
  };
  if (raw.transport === 'stdio') {
    // Mirrors OpenCollection's mcp-stdio-extension: shape-checked only. A
    // collection can describe a launch but never approve it — consent is
    // decided by Electron main at connect time (ADR 0030); nothing connects
    // at import.
    const argv = splitCommandLine(str(raw.command));
    const [command = '', ...args] = argv;
    const env = arr(raw.env)
      .filter(isObj)
      .map((e) => ({ key: str(e.key), value: str(e.value), enabled: e.disabled !== true }));
    const stdio = mcpStdioFromOC({ command, args, env });
    req.transport = 'stdio';
    if (stdio) req.stdio = stdio;
    ctx.report.unmodelled(
      'mcp-stdio',
      name,
      stdioWarning(
        argv,
        env.map((e) => e.key)
      )
    );
  } else {
    req.url = str(raw.url);
    req.headers = rows(raw.headers);
    // The v3 schema's only remote transport is `sse` (HTTP + Server-Sent Events).
    req.transport = raw.transport === 'sse' ? 'http-sse' : 'streamable-http';
  }
  if (typeof raw.message === 'string' && raw.message.trim() !== '') {
    try {
      const msg = JSON.parse(raw.message) as unknown;
      if (isObj(msg) && typeof msg.method === 'string') {
        req.defaultMethod = msg.method;
        if (msg.params !== undefined) req.defaultParams = JSON.stringify(msg.params);
      }
    } catch {
      // Not JSON-RPC: nothing to pre-fill.
    }
  }
  const unmapped: Raw = {};
  for (const k of ['version', 'requestTimeout', 'sessionTimeout', 'strictSSL'] as const) {
    if (settings[k] !== undefined) unmapped[k] = settings[k];
  }
  keepSettingsRest(Object.keys(unmapped).length > 0 ? unmapped : undefined, name, sidecar, ctx);
  return { req, inherits: authOut.auth === undefined };
}
