import { v4 as uuid } from 'uuid';
import { kafkaEntryToInternal, mqttEntryToInternal } from '../../opencollection/broker-items';
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
import { redactCommandArgv, splitCommandLine } from './text-redaction';

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
  const keys = Object.keys(leftovers);
  if (keys.length === 0) return;
  sidecar.leftovers = scrub(leftovers);
  ctx.report.unmodelled('broker-leftovers', name, keys.join(', '));
}

/** Payload encodings Restura's MQTT model cannot express (payloads are sent as text). */
const MQTT_BINARY_ENCODINGS = new Set(['hex', 'base64']);

export const MQTT_MAPPED_SETTINGS = new Set([
  'keepAlive',
  'cleanSession',
  'autoReconnect',
  'connectionTimeout',
]);

const MQTT_MAPPED_MESSAGE_PROPERTIES = new Set(['contentType', 'responseTopic', 'userProperties']);

export function convertMqtt(raw: Raw, name: string, sidecar: PostmanSidecar, ctx: ParseContext) {
  const settings = isObj(raw.settings) ? raw.settings : {};
  const messages = arr(raw.messages).filter(isObj);
  const topics = arr(raw.topics).filter(isObj);
  const subscribe = topics.find((t) => t.subscribe !== false) ?? topics[0];
  const lastWill = isObj(raw.lastWill) ? raw.lastWill : undefined;
  const publish = (m: Raw) => {
    // MQTT 5 message properties Restura models; the others are kept.
    const props = isObj(m.properties) ? m.properties : {};
    const userProperties = Object.fromEntries(
      arr(props.userProperties)
        .filter(isObj)
        .filter((p) => typeof p.key === 'string' && p.key !== '')
        .map((p) => [str(p.key), str(p.value)])
    );
    return {
      topic: m.topic,
      payload: m.content,
      qos: m.qos,
      retain: m.retain,
      contentType: props.contentType,
      responseTopic: props.responseTopic,
      ...(Object.keys(userProperties).length > 0 ? { userProperties } : {}),
    };
  };
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
  const otherProps = messages
    .map((m) => {
      const props = isObj(m.properties) ? m.properties : {};
      const rest = Object.fromEntries(
        Object.entries(props).filter(([k]) => !MQTT_MAPPED_MESSAGE_PROPERTIES.has(k))
      );
      return Object.keys(rest).length > 0 ? { message: str(m.name), properties: rest } : undefined;
    })
    .filter((p) => p !== undefined);
  if (otherProps.length > 0) leftovers.messageProperties = otherProps;
  // Hex / base64 payloads would be published as their text: keep the payload
  // visible but record (and warn about) the encoding the bytes need.
  const payloadEncodings = [
    ...messages.map((m, i) => ({
      message: str(m.name) || `#${i + 1}`,
      contentType: m.contentType,
    })),
    ...(lastWill ? [{ message: 'lastWill', contentType: lastWill.type }] : []),
  ].filter((e) => MQTT_BINARY_ENCODINGS.has(str(e.contentType)));
  if (payloadEncodings.length > 0) leftovers.payloadEncodings = payloadEncodings;
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

/** Hex text (whitespace allowed) → base64, or undefined when it is not plain hex. */
export function hexToBase64(hex: string): string | undefined {
  const h = hex.replace(/\s+/g, '');
  if (h.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(h)) return undefined;
  let binary = '';
  for (let i = 0; i < h.length; i += 2)
    binary += String.fromCharCode(parseInt(h.slice(i, i + 2), 16));
  return btoa(binary);
}

/**
 * A v3 Kafka key / value → Restura content + encoding. Hex has no Restura
 * encoding, so it is converted to the same bytes in base64; content that is
 * not plain hex (a `{{var}}`, a typo) or an unknown encoding cannot be sent
 * correctly and is kept in `leftovers` (warned) instead of silently re-encoded.
 */
function kafkaContent(c: unknown, side: 'key' | 'value', leftovers: Raw) {
  const raw = isObj(c) ? c : {};
  const type = str(raw.contentType);
  const text = str(raw.content);
  if (type === 'hex') {
    const b64 = hexToBase64(text);
    if (b64 !== undefined) return { content: b64, encoding: 'base64' };
  }
  const encoding = KAFKA_ENCODINGS[type];
  if (type !== '' && encoding === undefined) leftovers[side] = raw;
  return { content: text, encoding };
}

function kafkaBrokers(url: unknown): string[] {
  const list = typeof url === 'string' ? url.split(',') : arr(url);
  return list.map((b) => str(b).trim()).filter((b) => b !== '');
}

export function convertKafka(raw: Raw, name: string, sidecar: PostmanSidecar, ctx: ParseContext) {
  const settings = isObj(raw.settings) ? raw.settings : {};
  const messages = arr(raw.messages).filter(isObj);
  const first = messages[0];
  const consumer = raw.mode === 'consumer';
  const startPosition = isObj(raw.startPosition) ? raw.startPosition : {};
  const start = str(startPosition.type);
  keepBrokerAuth(raw, name, sidecar, ctx);
  keepSchema(raw, name, sidecar, ctx);
  // Kafka presets have no script slots: every script is kept and reported.
  const scripts = arr(raw.scripts);
  if (scripts.length > 0) keepScripts(scripts, name, sidecar, ctx);
  const leftovers: Raw = {};
  if (consumer && raw.stopAfter !== undefined) leftovers.stopAfter = raw.stopAfter;
  if (messages.length > 1) leftovers.messages = messages.slice(1);
  // Restura's `timestamp` consume mode has no timestamp field: keep the value.
  if (Object.keys(startPosition).some((k) => k !== 'type')) leftovers.startPosition = startPosition;
  const key = first ? kafkaContent(first.key, 'key', leftovers) : undefined;
  const value = first ? kafkaContent(first.value, 'value', leftovers) : undefined;
  keepLeftovers(leftovers, name, sidecar, ctx);
  if (settings.strictSSL === false) {
    ctx.report.securityDowngrade('strictSSL', name, 'TLS certificate verification is off');
  }
  const req: KafkaRequest = kafkaEntryToInternal({
    info: { name, description: description(raw.description) },
    kafka: {
      connection: {
        bootstrapBrokers: kafkaBrokers(raw.url),
        securityProtocol: settings.secureConnection === true ? 'SSL' : 'PLAINTEXT',
        acks: KAFKA_ACKS[str(raw.acknowledgements)],
        compression: settings.compression,
        ...(settings.strictSSL === false ? { tls: { rejectUnauthorized: false } } : {}),
      },
      produce: first
        ? {
            topic: first.topic,
            key: key?.content,
            keyEncoding: key?.encoding,
            value: value?.content,
            valueEncoding: value?.encoding,
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

export { splitCommandLine };

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

/**
 * MCP stdio imports DISABLED (ADR 0034 §5): an imported file must never be
 * able to launch a local process, so the item becomes a placeholder (built by
 * the caller) and only the launch shape is kept for reference — command,
 * argv and env NAMES (never env values), scrubbed like every sidecar value.
 */
export function keepMcpStdio(raw: Raw, name: string, sidecar: PostmanSidecar, ctx: ParseContext) {
  const argv = splitCommandLine(str(raw.command));
  const env = arr(raw.env)
    .filter(isObj)
    .map((e) => ({ key: str(e.key), ...(e.disabled === true ? { disabled: true } : {}) }));
  // scrub() blanks secret-flag / KEY=VALUE / URL-userinfo values in both
  // `argv` and `command`; the warning shows the same redacted argv.
  sidecar.item = scrub({ ...raw, argv, env });
  ctx.report.unmodelled(
    'mcp-stdio',
    name,
    stdioWarning(
      redactCommandArgv(argv),
      env.map((e) => e.key)
    )
  );
}

export function convertMcp(raw: Raw, name: string, sidecar: PostmanSidecar, ctx: ParseContext) {
  const authOut = convertAuth(raw.auth, name, sidecar, ctx);
  const scripts = extractScripts(raw.scripts, name, sidecar, ctx);
  const settings = isObj(raw.settings) ? raw.settings : {};
  // McpRequest has no description field: kept for export, like a folder's.
  const desc = description(raw.description);
  if (desc) sidecar.description = desc;
  const req: McpRequest = {
    id: uuid(),
    name,
    type: 'mcp',
    url: '',
    transport: 'streamable-http',
    headers: [],
    auth: authOut.auth ?? { type: 'none' },
    ...({
      preRequestScript: scripts.preRequestScript,
      testScript: scripts.testScript,
    } as Pick<McpRequest, 'preRequestScript' | 'testScript'>),
  };
  req.url = str(raw.url);
  req.headers = rows(raw.headers);
  // The v3 schema's only remote transport is `sse` (HTTP + Server-Sent Events);
  // stdio never reaches here (see keepMcpStdio).
  req.transport = raw.transport === 'sse' ? 'http-sse' : 'streamable-http';
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
