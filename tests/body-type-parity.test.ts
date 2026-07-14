/**
 * Parity between the shared protocol core's body types
 * (`ProxyBodyType` / `FormField` in `shared/protocol/body-builder.ts`) and
 * their Zod mirrors (`BodyTypeSchema` / `FormFieldSchema` in
 * `shared/protocol/proxy-schema.ts`).
 *
 * The schema validates every `/api/proxy` body at the Worker boundary, so if
 * the type and its schema drift, a body shape the type allows would be
 * rejected at the wire (or vice versa). These checks keep them locked.
 */

import type { FormField, ProxyBodyType } from '@shared/protocol/body-builder';
import { BodyTypeSchema, FormFieldSchema } from '@shared/protocol/proxy-schema';
import { describe, expect, it } from 'vitest';
import { type Equals, expectTypeEqual } from './helpers/typeEquality';

describe('ProxyBodyType / BodyTypeSchema parity', () => {
  it('the type and its schema enum are identical (compile-time)', () => {
    expectTypeEqual<Equals<ProxyBodyType, ReturnType<typeof BodyTypeSchema.parse>>>();
  });

  it('every ProxyBodyType member is accepted by the schema (runtime)', () => {
    // Exhaustive over ProxyBodyType at compile time via the Record key set.
    const allBodyTypes: Record<ProxyBodyType, true> = {
      none: true,
      json: true,
      text: true,
      raw: true,
      'form-urlencoded': true,
      'form-data': true,
      binary: true,
    };
    for (const t of Object.keys(allBodyTypes)) {
      expect(BodyTypeSchema.safeParse(t).success).toBe(true);
    }
    expect(BodyTypeSchema.safeParse('xml').success).toBe(false);
  });
});

describe('FormField / FormFieldSchema parity', () => {
  it('the interface and its schema are identical (compile-time)', () => {
    expectTypeEqual<Equals<FormField, ReturnType<typeof FormFieldSchema.parse>>>();
  });

  it('representative form fields parse against the schema (runtime)', () => {
    const samples: FormField[] = [
      { name: 'plain', value: 'v' },
      {
        name: 'file',
        value: 'base64==',
        filename: 'a.bin',
        contentType: 'application/octet-stream',
      },
    ];
    for (const f of samples) {
      expect(FormFieldSchema.safeParse(f).success).toBe(true);
    }
  });
});
