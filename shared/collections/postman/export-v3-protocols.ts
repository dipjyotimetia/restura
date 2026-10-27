import type { AuthConfig, KafkaRequest, McpRequest, MqttRequest } from '../../types';
import { arr, isObj, type Raw } from './common';
import { nonEmpty, type RequestOut, requestAuth } from './export-v3-http';
import {
  AUTH_TYPES,
  defined,
  type ExportContext,
  KAFKA_PHASES,
  kvRows,
  restoreBagOnlyAuth,
  restoreScripts,
} from './export-v3-shared';
import type { PostmanSidecar } from './sidecar';

/**
 * Restura MQTT / Kafka presets and MCP requests → Postman v3 `mqtt-request`,
 * `kafka-request`, `mcp-request` (#1201). The inverse of
 * `parse-v3-protocols.ts`; broker leftovers and bag-only auth kept in the
 * sidecar at import are restored.
 */

function leftovers(sidecar: PostmanSidecar | undefined): Raw {
  return isObj(sidecar?.leftovers) ? sidecar.leftovers : {};
}

const MQTT_SETTINGS_REST = new Set(['strictSSL']);

export function exportMqtt(
  req: MqttRequest,
  name: string,
  sidecar: PostmanSidecar | undefined,
  ctx: ExportContext
): RequestOut {
  const c = req.connection;
  const left = leftovers(sidecar);
  const extras = [
    c.username ? 'username' : '',
    c.tls ? 'TLS' : '',
    c.sessionExpiryInterval !== undefined ? 'session expiry' : '',
    [req.publish, ...req.templates].some(
      (p) =>
        p.contentType ||
        p.responseTopic ||
        (p.userProperties && Object.keys(p.userProperties).length)
    )
      ? 'message properties'
      : '',
  ].filter(Boolean);
  if (extras.length > 0) ctx.report.dropped('mqtt-extras', name, extras.join(', '));
  if (arr(sidecar?.response).length > 0) ctx.report.dropped('examples', name);
  const message = (n: string, p: MqttRequest['publish']) =>
    defined({
      name: n,
      $kind: 'mqtt-message',
      content: p.payload,
      topic: p.topic,
      qos: p.qos,
      retain: p.retain ? true : undefined,
      contentType: 'text',
    });
  const messages: Raw[] = [];
  const hasPublish = req.publish.topic !== '' || req.publish.payload !== '';
  if (hasPublish || req.templates.length > 0) messages.push(message('Message', req.publish));
  for (const t of req.templates) messages.push(message(t.name || 'Message', t));
  const topics: Raw[] = [];
  if (req.subscribe.topicFilter) {
    topics.push({ name: req.subscribe.topicFilter, qos: req.subscribe.qos, subscribe: true });
  }
  for (const t of arr(left.topics)) if (isObj(t)) topics.push(t);
  const settings = defined({
    cleanSession: c.cleanStart,
    keepAlive: c.keepalive,
    autoReconnect: c.autoReconnect,
    connectionTimeout: c.connectTimeout,
    ...Object.fromEntries(
      Object.entries(isObj(left.settings) ? left.settings : {}).filter(([k]) =>
        MQTT_SETTINGS_REST.has(k)
      )
    ),
  });
  return {
    item: defined({
      name,
      $kind: 'mqtt-request',
      description: req.description || undefined,
      url: c.brokerUrl,
      clientId: c.clientId || undefined,
      version: c.protocolVersion,
      topics: nonEmpty(topics),
      lastWill: c.lwt
        ? defined({
            payload: c.lwt.payload,
            topic: c.lwt.topic,
            qos: c.lwt.qos,
            retain: c.lwt.retain,
          })
        : undefined,
      properties: isObj(left.properties) ? left.properties : undefined,
      auth: restoreBagOnlyAuth(sidecar, AUTH_TYPES.mqtt, name, ctx),
      settings,
      messages: nonEmpty(messages),
    }),
  };
}

const ACKS: Record<string, string> = { '0': 'none', '1': 'leader', '-1': 'all' };
const ENCODINGS: Record<KafkaRequest['produce']['keyEncoding'], string> = {
  utf8: 'text',
  json: 'json',
  base64: 'base64',
};

export function exportKafka(
  req: KafkaRequest,
  name: string,
  sidecar: PostmanSidecar | undefined,
  ctx: ExportContext
): RequestOut {
  const c = req.connection;
  const left = leftovers(sidecar);
  const extras = [
    c.clientId ? 'client id' : '',
    c.sasl ? 'SASL' : '',
    c.registry ? 'schema registry' : '',
    c.tls && (c.tls.caPath || c.tls.certPath || c.tls.keyPath) ? 'TLS files' : '',
    c.idempotent ? 'idempotence' : '',
    c.transactionalId ? 'transactional id' : '',
    req.consume.groupId ? 'group id' : '',
  ].filter(Boolean);
  if (extras.length > 0) ctx.report.dropped('kafka-extras', name, extras.join(', '));
  if (req.description) ctx.report.dropped('description', name);
  const consumer = req.consume.topics.length > 0 && req.produce.topic === '';
  if (!consumer && req.consume.topics.length > 0) ctx.report.dropped('kafka-mode', name);
  const secure = c.securityProtocol === 'SSL' || c.securityProtocol === 'SASL_SSL';
  const settings = defined({
    secureConnection: secure ? true : undefined,
    strictSSL: c.tls?.rejectUnauthorized === false ? false : undefined,
    compression: c.compression !== 'none' ? c.compression : undefined,
  });
  const common = {
    $kind: 'kafka-request',
    name,
    url: c.bootstrapBrokers,
    auth: restoreBagOnlyAuth(sidecar, AUTH_TYPES.kafka, name, ctx),
    settings: Object.keys(settings).length > 0 ? settings : undefined,
    schema: isObj(sidecar?.schema) ? sidecar.schema : undefined,
    scripts: restoreScripts(sidecar, KAFKA_PHASES),
  };
  if (consumer) {
    const mode = req.consume.mode;
    if (mode !== 'earliest' && mode !== 'latest') {
      ctx.report.approximated('kafka-mode', name, `start position "${mode}" exported as "end"`);
    }
    return {
      item: defined({
        ...common,
        mode: 'consumer',
        topics: req.consume.topics.map((t) => ({ name: t })),
        startPosition: { type: mode === 'earliest' ? 'beginning' : 'end' },
        stopAfter: isObj(left.stopAfter) ? left.stopAfter : undefined,
      }),
    };
  }
  const p = req.produce;
  const first = defined({
    $kind: 'kafka-message',
    name: 'Message',
    topic: p.topic,
    key: { contentType: ENCODINGS[p.keyEncoding], content: p.key },
    value: { contentType: ENCODINGS[p.valueEncoding], content: p.value },
    headers: nonEmpty(kvRows(p.headers, name, ctx)),
    partition: p.partition,
  });
  const messages: Raw[] = p.topic || p.key || p.value ? [first] : [];
  for (const m of arr(left.messages)) if (isObj(m)) messages.push(m);
  return {
    item: defined({
      ...common,
      mode: 'producer',
      acknowledgements: ACKS[String(c.acks)],
      messages: nonEmpty(messages),
    }),
  };
}

// ── MCP ─────────────────────────────────────────────────────────────────────

/** argv → one command line `splitCommandLine` (parse-v3-protocols) splits back. */
export function joinCommandLine(argv: readonly string[]): { line: string; lossless: boolean } {
  let lossless = true;
  const parts = argv.map((a) => {
    if (a !== '' && !/[\s"']/.test(a)) return a;
    if (!a.includes('"')) return `"${a}"`;
    if (!a.includes("'")) return `'${a}'`;
    lossless = false;
    return `"${a.replace(/"/g, '')}"`;
  });
  return { line: parts.join(' '), lossless };
}

const MCP_SETTINGS_SSE = new Set(['version', 'strictSSL', 'requestTimeout', 'sessionTimeout']);
const MCP_SETTINGS_STDIO = new Set(['version', 'requestTimeout']);

function mcpMessage(req: McpRequest, name: string, ctx: ExportContext): string | undefined {
  if (!req.defaultMethod) return undefined;
  const msg: Raw = { jsonrpc: '2.0', id: 1, method: req.defaultMethod };
  if (req.defaultParams !== undefined && req.defaultParams.trim() !== '') {
    try {
      msg.params = JSON.parse(req.defaultParams) as unknown;
    } catch {
      ctx.report.dropped('mcp-params', name);
    }
  }
  return JSON.stringify(msg);
}

export function exportMcp(
  req: McpRequest,
  name: string,
  inherited: AuthConfig | undefined,
  sidecar: PostmanSidecar | undefined,
  ctx: ExportContext
): RequestOut {
  if (req.preRequestScript || req.testScript) ctx.report.dropped('mcp-scripts', name);
  const stdio = req.transport === 'stdio';
  const settingsRaw = isObj(sidecar?.settings) ? sidecar.settings : {};
  const allowed = stdio ? MCP_SETTINGS_STDIO : MCP_SETTINGS_SSE;
  const settings = Object.fromEntries(Object.entries(settingsRaw).filter(([k]) => allowed.has(k)));
  const common = {
    name,
    $kind: 'mcp-request',
    message: mcpMessage(req, name, ctx),
    auth: requestAuth(req.auth, inherited, sidecar, AUTH_TYPES.mcp, name, ctx),
  };
  if (stdio) {
    const s = req.stdio;
    const { line, lossless } = joinCommandLine(s ? [s.command, ...s.args] : []);
    if (!lossless || s?.cwd) ctx.report.dropped('mcp-stdio-extras', name);
    return {
      item: defined({
        ...common,
        transport: 'stdio',
        command: line || undefined,
        env: nonEmpty(kvRows(s?.env, name, ctx)),
        settings: Object.keys(settings).length > 0 ? settings : undefined,
      }),
    };
  }
  if (req.transport === 'streamable-http') ctx.report.approximated('mcp-transport', name);
  return {
    item: defined({
      ...common,
      transport: 'sse',
      url: req.url,
      headers: nonEmpty(kvRows(req.headers, name, ctx)),
      settings: Object.keys(settings).length > 0 ? settings : undefined,
    }),
  };
}
