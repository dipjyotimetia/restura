import { describe, expect, it } from 'vitest';
import {
  OWS_BINDING_MANIFEST_VERSION,
  parseOwsSafeWorkflow,
  serializeOwsWorkflow,
} from '../owsSafeProfile';

const SAFE_WORKFLOW = `
document:
  dsl: 1.0.3
  name: safe-example
  version: 1.0.0
  namespace: restura
do:
  - initialise:
      set:
        variable: ready
`;

describe('OWS safe profile', () => {
  it('uses the native SDK to parse, normalize, and serialize a supported workflow', () => {
    const result = parseOwsSafeWorkflow(SAFE_WORKFLOW, {
      schemaVersion: OWS_BINDING_MANIFEST_VERSION,
      workflowId: 'safe-example',
      bindings: [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.workflow.workflow.document.name).toBe('safe-example');
    expect(result.workflow.graph.entryNode).toBeDefined();
    expect(result.workflow.flatGraph.nodes).not.toHaveLength(0);
    expect(JSON.parse(serializeOwsWorkflow(result.workflow.workflow))).toMatchObject({
      document: { name: 'safe-example' },
    });
  });

  it('rejects workflow tasks outside Restura’s safe profile before they can be bound', () => {
    const result = parseOwsSafeWorkflow(
      `
document:
  dsl: 1.0.3
  name: unsafe-example
  version: 1.0.0
  namespace: restura
do:
  - execute:
      run:
        shell:
          command: whoami
`,
      {
        schemaVersion: OWS_BINDING_MANIFEST_VERSION,
        workflowId: 'unsafe-example',
        bindings: [],
      }
    );

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [
        expect.objectContaining({ code: 'unsupported-task', path: 'do[0].execute.run' }),
      ],
    });
  });

  it('rejects bindings that do not correspond to an OWS task', () => {
    const result = parseOwsSafeWorkflow(SAFE_WORKFLOW, {
      schemaVersion: OWS_BINDING_MANIFEST_VERSION,
      workflowId: 'safe-example',
      bindings: [
        {
          taskPath: 'do[0].missing',
          protocol: 'http',
          requestId: 'request-1',
        },
      ],
    });

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'unknown-binding-task' })],
    });
  });

  it('requires a local binding for an SDK-valid external call', () => {
    const source = `
document:
  dsl: 1.0.3
  name: bound-http
  version: 1.0.0
  namespace: restura
do:
  - fetch:
      call: http
      with:
        method: get
        endpoint: https://example.test
`;

    expect(
      parseOwsSafeWorkflow(source, {
        schemaVersion: OWS_BINDING_MANIFEST_VERSION,
        workflowId: 'bound-http',
        bindings: [],
      })
    ).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'unbound-call', path: 'do[0].fetch' })],
    });

    expect(
      parseOwsSafeWorkflow(source, {
        schemaVersion: OWS_BINDING_MANIFEST_VERSION,
        workflowId: 'bound-http',
        bindings: [{ taskPath: 'do[0].fetch', protocol: 'http', requestId: 'request-1' }],
      })
    ).toMatchObject({ ok: true });
  });

  it('rejects a scheduled workflow even when the OWS document itself is valid', () => {
    const result = parseOwsSafeWorkflow(
      `
document:
  dsl: 1.0.3
  name: scheduled-example
  version: 1.0.0
  namespace: restura
schedule:
  every: PT1M
do:
  - initialise:
      set:
        variable: ready
`,
      {
        schemaVersion: OWS_BINDING_MANIFEST_VERSION,
        workflowId: 'scheduled-example',
        bindings: [],
      }
    );

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'unsupported-declaration', path: 'schedule' })],
    });
  });

  it('rejects reusable OWS secrets because Restura resolves secret handles only at execution time', () => {
    const result = parseOwsSafeWorkflow(
      `
document:
  dsl: 1.0.3
  name: secret-example
  version: 1.0.0
  namespace: restura
use:
  secrets:
    - production-token
do:
  - initialise:
      set:
        variable: ready
`,
      {
        schemaVersion: OWS_BINDING_MANIFEST_VERSION,
        workflowId: 'secret-example',
        bindings: [],
      }
    );

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [
        expect.objectContaining({ code: 'unsupported-declaration', path: 'use.secrets' }),
      ],
    });
  });

  it('rejects unsafe tasks nested inside an allowed control-flow task', () => {
    const result = parseOwsSafeWorkflow(
      `
document:
  dsl: 1.0.3
  name: nested-unsafe-example
  version: 1.0.0
  namespace: restura
do:
  - parallel:
      fork:
        branches:
          - execute:
              run:
                shell:
                  command: whoami
`,
      {
        schemaVersion: OWS_BINDING_MANIFEST_VERSION,
        workflowId: 'nested-unsafe-example',
        bindings: [],
      }
    );

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [
        expect.objectContaining({
          code: 'unsupported-task',
          path: 'do[0].parallel.fork.branches[0].execute.run',
        }),
      ],
    });
  });

  it('rejects credentialed URLs in an otherwise bound OWS call', () => {
    const result = parseOwsSafeWorkflow(
      `
document:
  dsl: 1.0.3
  name: credentialed-url-example
  version: 1.0.0
  namespace: restura
do:
  - fetch:
      call: http
      with:
        method: get
        endpoint: https://user:password@example.test
`,
      {
        schemaVersion: OWS_BINDING_MANIFEST_VERSION,
        workflowId: 'credentialed-url-example',
        bindings: [{ taskPath: 'do[0].fetch', protocol: 'http', requestId: 'request-1' }],
      }
    );

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [
        expect.objectContaining({ code: 'embedded-credential', path: 'do[0].fetch.with.endpoint' }),
      ],
    });
  });

  it('rejects inline call authentication so credentials stay behind Restura secret handles', () => {
    const result = parseOwsSafeWorkflow(
      `
document:
  dsl: 1.0.3
  name: inline-auth-example
  version: 1.0.0
  namespace: restura
do:
  - fetch:
      call: http
      with:
        method: get
        endpoint:
          uri: https://example.test
          authentication:
            bearer:
              token: imported-secret
`,
      {
        schemaVersion: OWS_BINDING_MANIFEST_VERSION,
        workflowId: 'inline-auth-example',
        bindings: [{ taskPath: 'do[0].fetch', protocol: 'http', requestId: 'request-1' }],
      }
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'inline-credential',
        path: 'do[0].fetch.with.endpoint.authentication',
      })
    );
  });

  it('rejects inline authorization headers in an otherwise bound OWS call', () => {
    const result = parseOwsSafeWorkflow(
      `
document:
  dsl: 1.0.3
  name: authorization-header-example
  version: 1.0.0
  namespace: restura
do:
  - fetch:
      call: http
      with:
        method: get
        endpoint: https://example.test
        headers:
          Authorization: Bearer imported-secret
`,
      {
        schemaVersion: OWS_BINDING_MANIFEST_VERSION,
        workflowId: 'authorization-header-example',
        bindings: [{ taskPath: 'do[0].fetch', protocol: 'http', requestId: 'request-1' }],
      }
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'inline-credential',
        path: 'do[0].fetch.with.headers.Authorization',
      })
    );
  });

  it('rejects inline request headers and query payloads instead of trying to classify their values', () => {
    const result = parseOwsSafeWorkflow(
      `
document:
  dsl: 1.0.3
  name: inline-request-data-example
  version: 1.0.0
  namespace: restura
do:
  - fetch:
      call: http
      with:
        method: get
        endpoint: https://example.test
        headers:
          Cookie: session=imported-secret
        query:
          api_key: imported-secret
`,
      {
        schemaVersion: OWS_BINDING_MANIFEST_VERSION,
        workflowId: 'inline-request-data-example',
        bindings: [{ taskPath: 'do[0].fetch', protocol: 'http', requestId: 'request-1' }],
      }
    );

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [
        expect.objectContaining({
          code: 'unsupported-call-argument',
          path: 'do[0].fetch.with.headers',
        }),
        expect.objectContaining({
          code: 'unsupported-call-argument',
          path: 'do[0].fetch.with.query',
        }),
      ],
    });
  });

  it('rejects workflow inputs until Restura has a secret-aware input resolver', () => {
    const result = parseOwsSafeWorkflow(
      `
document:
  dsl: 1.0.3
  name: input-example
  version: 1.0.0
  namespace: restura
input:
  schema:
    document:
      authentication:
        bearer:
          token: imported-secret
do:
  - initialise:
      set:
        variable: ready
`,
      {
        schemaVersion: OWS_BINDING_MANIFEST_VERSION,
        workflowId: 'input-example',
        bindings: [],
      }
    );

    expect(result).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'unsupported-declaration', path: 'input' })],
    });
  });

  it('rejects query-bearing endpoint URLs and arbitrary metadata', () => {
    const endpointResult = parseOwsSafeWorkflow(
      `
document:
  dsl: 1.0.3
  name: endpoint-query-example
  version: 1.0.0
  namespace: restura
do:
  - fetch:
      call: http
      with:
        method: get
        endpoint: https://example.test/resource?api_key=imported-secret
`,
      {
        schemaVersion: OWS_BINDING_MANIFEST_VERSION,
        workflowId: 'endpoint-query-example',
        bindings: [{ taskPath: 'do[0].fetch', protocol: 'http', requestId: 'request-1' }],
      }
    );

    expect(endpointResult).toMatchObject({
      ok: false,
      diagnostics: [
        expect.objectContaining({
          code: 'unsupported-call-argument',
          path: 'do[0].fetch.with.endpoint',
        }),
      ],
    });

    const metadataResult = parseOwsSafeWorkflow(
      `
document:
  dsl: 1.0.3
  name: metadata-example
  version: 1.0.0
  namespace: restura
  metadata:
    api_key: imported-secret
do:
  - initialise:
      set:
        variable: ready
`,
      {
        schemaVersion: OWS_BINDING_MANIFEST_VERSION,
        workflowId: 'metadata-example',
        bindings: [],
      }
    );

    expect(metadataResult).toMatchObject({
      ok: false,
      diagnostics: [
        expect.objectContaining({ code: 'unsupported-declaration', path: 'document.metadata' }),
      ],
    });
  });

  it('rejects workflow and task data transforms until their secret-aware runtime exists', () => {
    const result = parseOwsSafeWorkflow(
      `
document:
  dsl: 1.0.3
  name: data-transform-example
  version: 1.0.0
  namespace: restura
output:
  as:
    authorization: Bearer imported-secret
do:
  - initialise:
      input:
        from:
          authorization: Bearer imported-secret
      set:
        variable: ready
      export:
        as:
          api_key: imported-secret
`,
      {
        schemaVersion: OWS_BINDING_MANIFEST_VERSION,
        workflowId: 'data-transform-example',
        bindings: [],
      }
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'unsupported-declaration', path: 'output' }),
        expect.objectContaining({ code: 'unsupported-task-field', path: 'do[0].initialise.input' }),
        expect.objectContaining({
          code: 'unsupported-task-field',
          path: 'do[0].initialise.export',
        }),
      ])
    );
  });

  it('requires bindings to target a compatible OWS call', () => {
    const source = `
document:
  dsl: 1.0.3
  name: compatible-binding-example
  version: 1.0.0
  namespace: restura
do:
  - fetch:
      call: http
      with:
        method: get
        endpoint: https://example.test
  - initialise:
      set:
        variable: ready
`;

    expect(
      parseOwsSafeWorkflow(source, {
        schemaVersion: OWS_BINDING_MANIFEST_VERSION,
        workflowId: 'compatible-binding-example',
        bindings: [{ taskPath: 'do[0].fetch', protocol: 'mqtt', requestId: 'connection-1' }],
      })
    ).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'incompatible-binding', path: 'do[0].fetch' })],
    });

    const nonCallBinding = parseOwsSafeWorkflow(source, {
      schemaVersion: OWS_BINDING_MANIFEST_VERSION,
      workflowId: 'compatible-binding-example',
      bindings: [{ taskPath: 'do[1].initialise', protocol: 'http', requestId: 'request-1' }],
    });
    expect(nonCallBinding.ok).toBe(false);
    if (nonCallBinding.ok) return;
    expect(nonCallBinding.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'binding-target-not-call', path: 'do[1].initialise' })
    );
  });
});
