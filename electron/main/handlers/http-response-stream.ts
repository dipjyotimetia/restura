import { PassThrough, pipeline, type Readable, Transform } from 'node:stream';
import {
  createBrotliDecompress,
  createGunzip,
  createInflate,
  createZstdDecompress,
  constants as zlibConstants,
} from 'node:zlib';
import { MAX_RESPONSE_SIZE } from '@shared/protocol/http-proxy';

/**
 * Parse a Content-Encoding header value into its ordered coding list
 * (RFC 9110 §8.4: codings are listed in the order they were applied).
 * Tokens are case-insensitive; `identity` and empty members are dropped.
 */
export function parseContentEncoding(encoding: string | readonly string[] | undefined): string[] {
  if (encoding === undefined) return [];
  const raw = typeof encoding === 'string' ? encoding : encoding.join(',');
  return raw
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token !== '' && token !== 'identity');
}

/**
 * Most stacked codings we will decode. Real servers send one; a longer list is
 * only useful for amplification (each layer multiplies decode work), so the
 * body is left raw with a notice instead.
 */
export const MAX_STACKED_CODINGS = 3;

/**
 * RFC 9659 §3 caps the zstd window HTTP recipients must support at 8 MB
 * (windowLog 23). Refuse larger frame windows instead of zstd's 128 MB default.
 */
const ZSTD_WINDOW_LOG_MAX = 23;

/** Decoder factory per supported content-coding (the keys are the supported set). */
const DECOMPRESSORS: Readonly<Record<string, () => Transform>> = {
  gzip: () => createGunzip(),
  'x-gzip': () => createGunzip(),
  br: () => createBrotliDecompress(),
  deflate: () => createInflate(),
  zstd: () =>
    createZstdDecompress({
      params: { [zlibConstants.ZSTD_d_windowLogMax]: ZSTD_WINDOW_LOG_MAX },
    }),
};

function isSupportedCoding(coding: string): boolean {
  return Object.hasOwn(DECOMPRESSORS, coding);
}

/**
 * When a Content-Encoding lists a coding we can't decode — or more codings than
 * MAX_STACKED_CODINGS — the body is left raw (decoding a stack partially would
 * mislabel it). Returns a user-facing notice explaining why, or undefined when
 * the body decodes (or needs no decoding).
 */
export function contentEncodingNotice(
  encoding: string | readonly string[] | undefined
): string | undefined {
  const codings = parseContentEncoding(encoding);
  if (codings.length > MAX_STACKED_CODINGS) {
    return `Response body not decoded: ${codings.length} stacked Content-Encodings (max ${MAX_STACKED_CODINGS}) (${codings.join(', ')}). Showing raw bytes.`;
  }
  const unsupported = codings.filter((coding) => !isSupportedCoding(coding));
  if (unsupported.length === 0) return undefined;
  const names = unsupported.map((coding) => `"${coding}"`).join(', ');
  const label = unsupported.length === 1 ? 'Content-Encoding' : 'Content-Encodings';
  return `Response body not decoded: unsupported ${label} ${names} (${codings.join(', ')}). Showing raw bytes.`;
}

/**
 * Decode an Undici response body while enforcing the shared decompressed-size
 * cap on EVERY stage — an intermediate layer that inflates past the cap is
 * rejected even if the next layer would shrink it again.
 */
export function decodeBodyStream(
  source: Readable,
  encoding: string | readonly string[] | undefined
): Readable {
  const codings = parseContentEncoding(encoding);
  if (codings.length === 0 || codings.length > MAX_STACKED_CODINGS) return source;
  if (!codings.every(isSupportedCoding)) return source;

  // Decode in reverse order of application: the last-listed coding is outermost.
  const stages: Transform[] = [];
  for (const coding of [...codings].reverse()) {
    stages.push(DECOMPRESSORS[coding]!(), createSizeCapTransform());
  }

  // An empty body carries no compressed stream at all (zlib would report
  // "unexpected end of file"): only build the decoder once bytes arrive.
  const output = new PassThrough();
  let started = false;
  const start = (): void => {
    started = true;
    pipeline([source, ...stages, output], () => {
      // Errors surface from the returned stream.
    });
  };
  const onData = (chunk: Buffer): void => {
    if (chunk.length === 0) return;
    source.off('data', onData);
    source.pause();
    source.unshift(chunk);
    start();
  };
  source.on('data', onData);
  source.once('end', () => {
    if (!started) output.end();
  });
  source.once('error', (err) => {
    if (!started) output.destroy(err);
  });
  output.once('close', () => {
    if (!started) source.destroy();
  });
  return output;
}

export interface DecodedResponseBody {
  /** The body to read — decoded when possible, always size-capped. */
  body: Readable;
  /** True when content-coding was removed (Content-Encoding/-Length no longer apply). */
  decoded: boolean;
  /** Set when an unsupported coding left the body raw (see contentEncodingNotice). */
  notice?: string;
}

/**
 * The Content-Encoding to decode for a response. HEAD, 204 and 304 responses
 * have no content by definition — their Content-Encoding describes the
 * representation, not bytes on the wire — so nothing is decoded.
 */
export function wireCodings(
  method: string,
  status: number,
  headers: Record<string, string | string[] | undefined>
): string | string[] | undefined {
  if (method === 'HEAD' || status === 204 || status === 304) return undefined;
  return headers['content-encoding'];
}

/** Decode (when possible) and size-cap a response body in one step. */
export function decodeResponseBody(
  source: Readable,
  encoding: string | readonly string[] | undefined
): DecodedResponseBody {
  const decodedStream = decodeBodyStream(source, encoding);
  const decoded = decodedStream !== source;
  const notice = contentEncodingNotice(encoding);
  return {
    body: decoded ? decodedStream : capBodyStream(source),
    decoded,
    ...(notice ? { notice } : {}),
  };
}

/** Apply the shared response cap to a body that does not need decompression. */
export function capBodyStream(source: Readable): Readable {
  const capped = createSizeCapTransform();
  pipeline(source, capped, () => {
    // Errors surface from the returned stream.
  });
  return capped;
}

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

/** Preserve text bodies when JSON parsing is not applicable. */
export function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
