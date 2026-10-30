import { describe, expect, it } from 'vitest';
import { CAPABILITIES } from './capabilities';

// Every `*_CAPABILITIES` record exported from an area module under
// ./capabilities/. Globbed so a new area module is checked without editing
// this test.
const areaModules = import.meta.glob<Record<string, unknown>>('./capabilities/*.ts', {
  eager: true,
});
const areas = Object.entries(areaModules).flatMap(([file, mod]) =>
  Object.entries(mod)
    .filter(([name]) => name.endsWith('_CAPABILITIES'))
    .map(([name, record]) => ({ file, name, keys: Object.keys(record as object) }))
);

describe('capability area modules', () => {
  it('never declares the same capability key in two area modules', () => {
    const owners = new Map<string, string[]>();
    for (const area of areas) {
      for (const key of area.keys) owners.set(key, [...(owners.get(key) ?? []), area.name]);
    }
    const duplicates = [...owners].filter(([, names]) => names.length > 1);
    expect(duplicates).toEqual([]);
  });

  it('composes every area row into CAPABILITIES and nothing else', () => {
    expect(areas.length).toBeGreaterThan(0);
    const areaKeys = areas.flatMap((area) => area.keys).sort();
    expect(Object.keys(CAPABILITIES).sort()).toEqual(areaKeys);
  });
});

// Regression guard for the per-area split of the capability registry. The
// inline snapshot was recorded against the single-file registry before the
// split; iteration order drives docs/CAPABILITY_MATRIX.md, so it is asserted
// in insertion order (not sorted). Adding a capability updates this snapshot.
describe('capability registry shape', () => {
  it('keeps every capability key in its original order', () => {
    expect(Object.keys(CAPABILITIES)).toMatchInlineSnapshot(`
      [
        "http.basic",
        "graphql.basic",
        "graphql.incrementalDelivery",
        "http.proxy.socks",
        "http.proxy.pac",
        "http.mtls",
        "http.customCa",
        "http.manualRedirect",
        "http.connectionTimings",
        "http.dnsPinning",
        "http.tls.cipherSuite",
        "http.tls.minVersion",
        "http.version",
        "http.streamingResponse",
        "loadTesting.basic",
        "websocket.basic",
        "websocket.customHeaders",
        "websocket.viaWorkerProxy",
        "websocket.ping",
        "websocket.perMessageDeflateToggle",
        "sse.basic",
        "sse.customHeaders",
        "mcp.basic",
        "mcp.clientRequests",
        "mcp.serverNotifications",
        "mcp.resourceSubscriptions",
        "mcp.auth",
        "mcp.oauth",
        "mcp.stdio",
        "mcp.configImport",
        "mcp.conformance",
        "grpc.basic",
        "grpc.reflection",
        "grpc.web",
        "kafka.basic",
        "kafka.schemaRegistry",
        "kafka.saslOAuthRefresh",
        "kafka.saslMskIam",
        "kafka.saslGssapi",
        "mqtt.basic",
        "mqtt.websocket",
        "mqtt.binaryPayloads",
        "mqtt.v5Properties",
        "mqtt.requestResponse",
        "socketio.basic",
        "ai.basic",
        "ai.toolCalls",
        "ai.inlineActions",
        "ai.agentMode",
        "aiLab.basic",
        "aiLab.localProviders",
        "aiLab.evals",
        "aiLab.judge",
        "aiLab.httpExec",
        "aiLab.arena",
        "aiLab.agentSuites",
        "aiLab.agentProviders",
        "aiLab.agentRequestTools",
        "aiLab.agentMcpTools",
        "aiLab.agentSandboxes",
        "collections.file",
        "collections.git",
        "collections.brokerPresets",
        "collections.streamPresets",
        "collections.postmanImport",
        "collections.postmanV3Export",
        "workflows.ows",
        "mock.localServer",
        "capture.desktopBridge",
        "storage.osKeychain",
        "storage.encryptedLocal",
        "native.shell",
        "native.notifications",
        "native.tray",
        "scripts.basic",
        "scripts.sendRequest",
        "scripts.cookies",
        "scripts.setNextRequest",
        "scripts.visualizer",
        "scripts.vault",
        "scripts.judge",
      ]
    `);
  });
});
