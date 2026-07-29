import { pipeline, type Readable, Transform } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { MAX_RESPONSE_SIZE } from '@shared/protocol/http-proxy';

function createSizeCapTransform(): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      if (total > MAX_RESPONSE_SIZE) {
        callback(new Error(`Response too large (max ${MAX_RESPONSE_SIZE / 1024 / 1024}MB)`));
        return;
      }
      callback(null, chunk);
    },
  });
}

/** Decode a compressed response while enforcing the decompressed size cap. */
export function decodeBodyStream(source: Readable, encoding: string | undefined): Readable {
  const normalized = encoding?.trim().toLowerCase();
  const decompressor =
    normalized === 'gzip' || normalized === 'x-gzip'
      ? createGunzip()
      : normalized === 'br'
        ? createBrotliDecompress()
        : normalized === 'deflate'
          ? createInflate()
          : undefined;
  if (!decompressor) return source;

  const cap = createSizeCapTransform();
  pipeline(source, decompressor, cap, () => {
    /* errors surface on the returned cap stream */
  });
  return cap;
}

/** Enforce the response size cap on an already-decoded response stream. */
export function capBodyStream(source: Readable): Readable {
  const cap = createSizeCapTransform();
  pipeline(source, cap, () => {
    /* errors surface on the returned cap stream */
  });
  return cap;
}
