export interface FormField {
  name: string;
  value: string;
  filename?: string;
  contentType?: string;
}

export type BodyType =
  | 'none'
  | 'json'
  | 'text'
  | 'raw'
  | 'form-urlencoded'
  | 'form-data'
  | 'binary';

export interface BuildRequestBodyArgs {
  bodyType?: BodyType;
  data?: string;
  formData?: FormField[];
}

export interface BuiltRequestBody {
  body: BodyInit | undefined;
  contentType: string | undefined;
}

type Uint8ArrayCtorWithBase64 = typeof Uint8Array & {
  fromBase64?: (s: string) => Uint8Array<ArrayBuffer>;
};

interface BufferLike {
  from(s: string, encoding: 'base64'): Uint8Array;
}

function base64ToUint8Array(b64: string): Uint8Array<ArrayBuffer> {
  const ctor = Uint8Array as Uint8ArrayCtorWithBase64;
  if (typeof ctor.fromBase64 === 'function') {
    return ctor.fromBase64(b64);
  }
  const maybeBuffer = (globalThis as { Buffer?: BufferLike }).Buffer;
  if (maybeBuffer) {
    const buf = maybeBuffer.from(b64, 'base64');
    const out = new ArrayBuffer(buf.byteLength);
    new Uint8Array(out).set(buf);
    return new Uint8Array(out);
  }
  const binary = atob(b64);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function buildRequestBody(args: BuildRequestBodyArgs): BuiltRequestBody {
  const { bodyType, data, formData } = args;

  if (!bodyType || bodyType === 'none') {
    return { body: undefined, contentType: undefined };
  }

  switch (bodyType) {
    case 'json':
      return { body: data, contentType: 'application/json' };
    case 'text':
      return { body: data, contentType: 'text/plain' };
    case 'raw':
      return { body: data, contentType: undefined };
    case 'form-urlencoded': {
      const params = new URLSearchParams();
      if (formData) {
        for (const field of formData) params.append(field.name, field.value);
      } else if (data) {
        return { body: data, contentType: 'application/x-www-form-urlencoded' };
      }
      return { body: params.toString(), contentType: 'application/x-www-form-urlencoded' };
    }
    case 'form-data': {
      const fd = new FormData();
      if (formData) {
        for (const field of formData) {
          if (field.filename) {
            const bytes = base64ToUint8Array(field.value);
            const blob = new Blob([bytes], { type: field.contentType || 'application/octet-stream' });
            fd.append(field.name, blob, field.filename);
          } else {
            fd.append(field.name, field.value);
          }
        }
      }
      return { body: fd, contentType: undefined };
    }
    case 'binary':
      if (data) return { body: base64ToUint8Array(data), contentType: 'application/octet-stream' };
      return { body: undefined, contentType: undefined };
  }
}
