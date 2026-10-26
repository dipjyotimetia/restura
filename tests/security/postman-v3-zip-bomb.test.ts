// @vitest-environment node
import { crc32, createDeflateRaw } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { unzipPostmanV3Archive } from '../../shared/collections/postman/v3-archive';

/**
 * #1200 S5: a v3 zip entry that inflates to 1 GiB must hit the per-file cap
 * while only a bounded amount of it has been inflated. fflate's streaming
 * inflater decompresses everything pushed in one call, so the archive must be
 * fed in small slices with the counters checked between slices.
 */

const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;

/** Raw-deflate 1 GiB of zeros with native zlib (fast), returning bytes + CRC. */
async function deflatedZeros(total: number): Promise<{ data: Buffer; crc: number }> {
  const zeros = Buffer.alloc(MIB);
  const deflate = createDeflateRaw({ level: 9 });
  const chunks: Buffer[] = [];
  deflate.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve, reject) => {
    deflate.on('end', resolve);
    deflate.on('error', reject);
  });
  let crc = 0;
  for (let written = 0; written < total; written += MIB) {
    crc = crc32(zeros, crc);
    if (!deflate.write(zeros)) await new Promise((r) => deflate.once('drain', r));
  }
  deflate.end();
  await done;
  return { data: Buffer.concat(chunks), crc };
}

/** A single-entry zip (local header + data + central directory + EOCD). */
function zipOne(name: string, data: Buffer, crc: number, size: number): Uint8Array {
  const nameBytes = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt32LE(crc >>> 0, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(size >>> 0, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc >>> 0, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(size >>> 0, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  const cdOffset = local.length + nameBytes.length + data.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + nameBytes.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  return new Uint8Array(Buffer.concat([local, nameBytes, data, central, nameBytes, eocd]));
}

describe('Postman v3 zip bomb (#1200 S5)', () => {
  it('a 1 GiB entry is refused with bounded memory growth', async () => {
    // Declared size is a lie (small) so only the streaming counter can stop it.
    const { data, crc } = await deflatedZeros(GIB);
    const zip = zipOne('bomb.request.yaml', data, crc, 100);
    expect(zip.byteLength).toBeLessThan(2 * MIB);

    const before = process.memoryUsage();
    expect(() => unzipPostmanV3Archive(zip)).toThrowError(/too large/i);
    const after = process.memoryUsage();
    const grown = after.heapUsed + after.arrayBuffers - (before.heapUsed + before.arrayBuffers);
    expect(grown).toBeLessThan(200 * MIB);
  }, 30_000);
});
