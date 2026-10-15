import {
  descriptorsFromProtoFiles,
  registryFromProtoText,
  resolveMethod,
} from '@shared/protocol/grpc-registry';
import { findUnknownJsonFields } from '@shared/protocol/grpc-unknown-fields';
import { describe, expect, it } from 'vitest';
import { useSettingsStore } from '@/store/useSettingsStore';
import type { GrpcRequest } from '@/types';
import {
  applyUnknownFieldPolicy,
  grpcUnknownFieldsMode,
  maskTemplateVariables,
  parseMessageForLint,
  removeJsonKeys,
  renameJsonKey,
  resolveInputMessage,
  schemaSourceFromSnapshot,
  unknownFieldsResponse,
  unknownRequestFields,
  withoutUnknownFields,
} from '../unknownFields';

const PROTO = `syntax = "proto3";
package shop.v1;
message Item { string sku_id = 1; int32 qty = 2; }
message Order { string name = 1; repeated Item items = 2; int32 count = 3; }
service Shop { rpc Place(Order) returns (Order); }`;

const source = { protoContent: PROTO, protoFileName: 'shop.proto' };
const input = () =>
  resolveMethod(registryFromProtoText(PROTO, 'shop.proto'), 'shop.v1.Shop', 'Place').method.input;

function req(message: string): GrpcRequest {
  return {
    id: 'r1',
    name: 'Place',
    type: 'grpc',
    methodType: 'unary',
    url: 'http://localhost:50051',
    service: 'shop.v1.Shop',
    method: 'Place',
    metadata: [],
    message,
    auth: { type: 'none' },
  };
}

const TEXT = `{
  "nmae": "{{who}}",
  "count": {{n}},
  "items": [
    { "skuId": "a", "qyt": 2 }
  ]
}`;

describe('editor-text helpers (#944)', () => {
  it('masks {{variables}} without moving offsets', () => {
    const masked = maskTemplateVariables(TEXT);
    expect(masked).toHaveLength(TEXT.length);
    expect(parseMessageForLint(TEXT)).toMatchObject({ count: 0 });
  });

  it('flags unknown keys in templated text', () => {
    const found = findUnknownJsonFields(input(), parseMessageForLint(TEXT));
    expect(found.map((f) => [f.path, f.suggestion])).toEqual([
      ['nmae', 'name'],
      ['items[0].qyt', 'qty'],
    ]);
  });

  it('renames a key in place, keeping formatting and variables', () => {
    const [nmae, qyt] = findUnknownJsonFields(input(), parseMessageForLint(TEXT));
    const fixed = renameJsonKey(renameJsonKey(TEXT, nmae!, 'name'), qyt!, 'qty');
    expect(fixed).toBe(TEXT.replace('"nmae"', '"name"').replace('"qyt"', '"qty"'));
    expect(findUnknownJsonFields(input(), parseMessageForLint(fixed))).toEqual([]);
  });

  it('removes unknown keys, keeping the rest of the text intact', () => {
    const found = findUnknownJsonFields(input(), parseMessageForLint(TEXT));
    const stripped = removeJsonKeys(TEXT, found);
    expect(stripped).toContain('"count": {{n}}');
    expect(stripped).toContain('"skuId": "a"');
    expect(stripped).not.toContain('nmae');
    expect(stripped).not.toContain('qyt');
    expect(findUnknownJsonFields(input(), parseMessageForLint(stripped))).toEqual([]);
  });

  it('resolves no descriptor without a schema or with an unknown method', () => {
    expect(resolveInputMessage(req('{}'), {})).toBeNull();
    expect(resolveInputMessage({ service: 'shop.v1.Shop', method: 'Nope' }, source)).toBeNull();
  });

  it('strips unknown keys from a parsed streaming message', () => {
    expect(withoutUnknownFields(input(), { name: 'a', nmae: 'b' })).toEqual({ name: 'a' });
    expect(withoutUnknownFields(null, { nmae: 'b' })).toEqual({ nmae: 'b' });
  });
});

describe('applyUnknownFieldPolicy (#944)', () => {
  const resolve = (t: string) => t.replace('{{who}}', 'world').replace('{{n}}', '3');

  it('block: refuses with INVALID_ARGUMENT listing the keys', () => {
    const r = applyUnknownFieldPolicy(req(TEXT), source, resolve, 'block');
    expect(r.refused?.grpcStatus).toBe(3);
    expect(r.refused?.body).toContain('items[0].qyt');
    expect(r.request.message).toBe(TEXT);
  });

  it.each(['warn', 'off'] as const)('%s: sends without the unknown keys', (mode) => {
    const r = applyUnknownFieldPolicy(req(TEXT), source, resolve, mode);
    expect(r.refused).toBeUndefined();
    expect(r.request.message).not.toContain('nmae');
    expect(JSON.parse(resolve(r.request.message))).toEqual({
      count: 3,
      items: [{ skuId: 'a' }],
    });
  });

  it.each(['warn', 'off'] as const)(
    '%s: strips unknown keys a whole-body variable expands to',
    (mode) => {
      const body = (t: string) => t.replace('{{body}}', '{"name": "x", "nmae": "y"}');
      const r = applyUnknownFieldPolicy(req('{{body}}'), source, body, mode);
      expect(r.refused).toBeUndefined();
      expect(JSON.parse(r.request.message)).toEqual({ name: 'x' });
    }
  );

  it.each(['warn', 'off'] as const)('%s: keeps a valid key spelled by a variable', (mode) => {
    const key = (t: string) => t.replace('{{field}}', 'name');
    const r = applyUnknownFieldPolicy(req('{"{{field}}": "x"}'), source, key, mode);
    expect(r.refused).toBeUndefined();
    expect(JSON.parse(key(r.request.message))).toEqual({ name: 'x' });
  });

  it('block: refuses unknown keys a whole-body variable expands to', () => {
    const body = (t: string) => t.replace('{{body}}', '{"nmae": "y"}');
    expect(applyUnknownFieldPolicy(req('{{body}}'), source, body, 'block').refused?.body).toContain(
      'nmae'
    );
  });

  it('leaves a clean message untouched', () => {
    const clean = req('{"name": "x"}');
    expect(applyUnknownFieldPolicy(clean, source, resolve, 'warn').request).toBe(clean);
    expect(applyUnknownFieldPolicy(clean, source, resolve, 'block').refused).toBeUndefined();
  });
});

describe('unknown-field lint inputs that cannot be checked (#944)', () => {
  it('stays quiet without a service or method, or when the text is not JSON', () => {
    expect(resolveInputMessage({ service: '', method: 'Place' }, source)).toBeNull();
    expect(unknownRequestFields({ ...req('{"nmae": 1}'), method: '' }, source)).toEqual([]);
    expect(unknownRequestFields(req('{"nmae": '), source)).toEqual([]);
  });

  it('treats a blank editor as an empty message', () => {
    expect(parseMessageForLint('   ')).toEqual({});
    expect(unknownRequestFields(req(''), source)).toEqual([]);
  });

  it('leaves the text unchanged when a quick fix targets a key that is gone', () => {
    const [nmae] = findUnknownJsonFields(input(), parseMessageForLint(TEXT));
    expect(renameJsonKey('{"name": "x"}', nmae!, 'name')).toBe('{"name": "x"}');
    expect(renameJsonKey('', nmae!, 'name')).toBe('');
  });

  it('words the refusal generically when the request has no method', () => {
    const [nmae] = findUnknownJsonFields(input(), parseMessageForLint(TEXT));
    const r = unknownFieldsResponse('r1', [nmae!], '');
    expect(r.grpcStatus).toBe(3);
    expect(JSON.parse(r.body)).toMatchObject({
      error: expect.stringContaining('Unknown field(s) in the request message'),
      details: 'nmae (did you mean "name"?)',
    });
  });
});

describe('schema sources for the lint (#944)', () => {
  it('lints against a reflection snapshot as well as uploaded proto text', () => {
    const fromReflection = schemaSourceFromSnapshot({
      kind: 'descriptors',
      descriptors: descriptorsFromProtoFiles([{ path: 'shop.proto', content: PROTO }]),
    });
    const fromUpload = schemaSourceFromSnapshot({
      kind: 'proto',
      fileName: 'shop.proto',
      text: PROTO,
    });
    for (const s of [fromReflection, fromUpload]) {
      expect(unknownRequestFields(req('{"nmae": "x"}'), s).map((f) => f.path)).toEqual(['nmae']);
    }
    expect(schemaSourceFromSnapshot(undefined)).toEqual({});
  });

  it('defaults the policy to warn until the user picks one', () => {
    const settings = useSettingsStore.getState().settings;
    useSettingsStore.setState({ settings: { ...settings, grpcUnknownFields: undefined } });
    expect(grpcUnknownFieldsMode()).toBe('warn');
    useSettingsStore.setState({ settings: { ...settings, grpcUnknownFields: 'block' } });
    expect(grpcUnknownFieldsMode()).toBe('block');
    useSettingsStore.setState({ settings });
  });
});
