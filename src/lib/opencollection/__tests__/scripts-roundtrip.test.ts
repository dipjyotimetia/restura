import { describe, it, expect } from 'vitest';
import { parseOpenCollectionYAML, serializeOpenCollectionYAML } from '../serializer';
import { ocToInternal, getAndResetUnrecognizedScripts } from '../to-internal';
import { internalToOC } from '../from-internal';
import type { Collection } from '@/types';

/**
 * Collection-level and folder-level pre-request / test scripts round-trip
 * through the native OpenCollection `request.scripts` (RequestDefaults) field —
 * the same `Script[]` container the spec already defines for request-level
 * `runtime.scripts`. RequestDefaults is referenced by both the document root
 * `request` and every `Folder.request`, so it is the spec-clean home for the
 * collection/folder scripts that Restura runs against every descendant request.
 *
 * Mirrors auth-roundtrip.test.ts: scripts live in the same RequestDefaults bag,
 * so they carry the same import / verbatim / edit-then-export staleness
 * contract — and the same "don't recompute auth when only scripts changed"
 * trap (OAuth1/NTLM/WSSE survive only via the cached _oc bytes).
 */

const SOURCE_YAML = `opencollection: 1.0.0
info:
  name: Scripts Demo
request:
  scripts:
    - type: before-request
      code: rs.environment.set('root', 1)
    - type: tests
      code: rs.test('root ok', () => {})
items:
  - info:
      name: Scripted Folder
    request:
      scripts:
        - type: before-request
          code: rs.environment.set('folder', 2)
    items:
      - info:
          type: http
          name: Inner
        http:
          method: GET
          url: https://api.example.com/inner
  - info:
      type: http
      name: Top
    http:
      method: GET
      url: https://api.example.com/top
`;

describe('OpenCollection collection/folder scripts', () => {
  it('import populates collection + folder script fields (functional on a run)', () => {
    const oc = parseOpenCollectionYAML(SOURCE_YAML);
    const internal = ocToInternal(oc);

    expect(internal.preRequestScript).toBe("rs.environment.set('root', 1)");
    expect(internal.testScript).toBe("rs.test('root ok', () => {})");

    const folder = internal.items.find((i) => i.type === 'folder');
    expect(folder?.preRequestScript).toBe("rs.environment.set('folder', 2)");
    expect(folder?.testScript).toBeUndefined();
  });

  it('import leaves script fields unset when the document has none', () => {
    const oc = parseOpenCollectionYAML('opencollection: 1.0.0\ninfo:\n  name: Plain\nitems: []\n');
    const internal = ocToInternal(oc);
    expect(internal.preRequestScript).toBeUndefined();
    expect(internal.testScript).toBeUndefined();
  });

  it('round-trips byte-stable when nothing was edited', () => {
    const oc = parseOpenCollectionYAML(SOURCE_YAML);
    const internal = ocToInternal(oc) as Collection & { _oc?: unknown };
    const out = internalToOC(internal);
    expect(serializeOpenCollectionYAML(out)).toBe(serializeOpenCollectionYAML(oc));
  });

  it('edit-then-export: an edited collection script reaches the output (no stale cache)', () => {
    const oc = parseOpenCollectionYAML(SOURCE_YAML);
    const internal = ocToInternal(oc) as Collection & { _oc?: unknown };
    internal.preRequestScript = "rs.environment.set('root', 99)";

    const out = internalToOC(internal);
    const scripts = (out.request as { scripts?: Array<{ type: string; code: string }> }).scripts;
    const pre = scripts?.find((s) => s.type === 'before-request');
    expect(pre?.code).toBe("rs.environment.set('root', 99)");
    // Unedited test script still emits.
    expect(scripts?.find((s) => s.type === 'tests')?.code).toBe("rs.test('root ok', () => {})");
    // Unedited folder script still emits verbatim.
    const folder = (out.items as Array<Record<string, unknown>>).find(
      (i) => (i.info as { name?: string })?.name === 'Scripted Folder'
    );
    const fScripts = (folder?.request as { scripts?: Array<{ code: string }> })?.scripts;
    expect(fScripts?.[0]?.code).toBe("rs.environment.set('folder', 2)");
  });

  it('edit-then-export: an edited folder script reaches the output', () => {
    const oc = parseOpenCollectionYAML(SOURCE_YAML);
    const internal = ocToInternal(oc) as Collection & { _oc?: unknown };
    const folder = internal.items.find((i) => i.type === 'folder')!;
    folder.preRequestScript = "rs.environment.set('folder', 200)";

    const out = internalToOC(internal);
    const outFolder = (out.items as Array<Record<string, unknown>>).find(
      (i) => (i.info as { name?: string })?.name === 'Scripted Folder'
    );
    const scripts = (outFolder?.request as { scripts?: Array<{ type: string; code: string }> })
      ?.scripts;
    expect(scripts?.find((s) => s.type === 'before-request')?.code).toBe(
      "rs.environment.set('folder', 200)"
    );
    // Unedited child request inside the rebuilt folder still emits verbatim.
    const children = outFolder?.items as Array<Record<string, unknown>>;
    expect((children[0]?.info as { name?: string })?.name).toBe('Inner');
  });

  it('clearing collection scripts removes request.scripts (and request when empty)', () => {
    const oc = parseOpenCollectionYAML(SOURCE_YAML);
    const internal = ocToInternal(oc) as Collection & { _oc?: unknown };
    delete internal.preRequestScript;
    delete internal.testScript;
    const out = internalToOC(internal);
    // Root request bag only held scripts → it disappears entirely.
    expect(out.request).toBeUndefined();
  });

  it('from-scratch export (no _oc) emits collection + folder scripts at request.scripts', () => {
    const internal: Collection = {
      id: 'c1',
      name: 'Native',
      preRequestScript: 'rs.collection.pre()',
      testScript: 'rs.collection.test()',
      items: [
        {
          id: 'f1',
          name: 'F',
          type: 'folder',
          preRequestScript: 'rs.folder.pre()',
          items: [],
        },
      ],
    };
    const out = internalToOC(internal);
    const rootScripts = (out.request as { scripts?: Array<{ type: string; code: string }> })
      .scripts;
    expect(rootScripts?.find((s) => s.type === 'before-request')?.code).toBe('rs.collection.pre()');
    expect(rootScripts?.find((s) => s.type === 'tests')?.code).toBe('rs.collection.test()');

    const folder = (out.items as Array<Record<string, unknown>>)[0]!;
    const fScripts = (folder.request as { scripts?: Array<{ type: string; code: string }> })
      .scripts;
    expect(fScripts?.find((s) => s.type === 'before-request')?.code).toBe('rs.folder.pre()');
  });

  it('after-response / hooks at collection level count as unrecognized on import', () => {
    const yaml = `opencollection: 1.0.0
info:
  name: Hooks Demo
request:
  scripts:
    - type: after-response
      code: rs.noop()
items: []
`;
    const oc = parseOpenCollectionYAML(yaml);
    ocToInternal(oc);
    const unrecognized = getAndResetUnrecognizedScripts();
    expect(unrecognized).toContainEqual({ type: 'after-response', requestName: 'Hooks Demo' });
  });

  // The trap (advisor-flagged): OAuth1/NTLM/WSSE degrade to 'none' through
  // authToInternal, so cached auth survives ONLY via the verbatim _oc bytes.
  // Editing just a script must NOT recompute (and thereby delete) that auth.
  it('editing only a script preserves un-modellable root auth (oauth1)', () => {
    const yaml = `opencollection: 1.0.0
info:
  name: Trap
request:
  auth:
    type: oauth1
    consumerKey: ck
    consumerSecret: cs
  scripts:
    - type: before-request
      code: rs.original()
items:
  - info:
      type: http
      name: Only
    http:
      method: GET
      url: https://api.example.com/x
`;
    const oc = parseOpenCollectionYAML(yaml);
    const internal = ocToInternal(oc) as Collection & { _oc?: unknown };
    // oauth1 has no internal representation → degrades to undefined auth.
    expect(internal.auth).toBeUndefined();

    internal.preRequestScript = 'rs.edited()';
    const out = internalToOC(internal);

    const request = out.request as {
      auth?: { type?: string; consumerKey?: string };
      scripts?: Array<{ code: string }>;
    };
    // OAuth1 block survived the script-only edit.
    expect(request.auth?.type).toBe('oauth1');
    expect(request.auth?.consumerKey).toBe('ck');
    // Script edit reached the output.
    expect(request.scripts?.find((s) => s.code === 'rs.edited()')).toBeTruthy();
  });
});
