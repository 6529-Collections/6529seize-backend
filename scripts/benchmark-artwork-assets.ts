import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import {
  hashAssetStream,
  PREVIEW_FILE_LIMIT,
  PREVIEW_PIXEL_LIMIT
} from '../src/artwork-documentation/assets/artwork-assets.inspection';
import { characterizeMp4 } from '../src/artwork-documentation/assets/artwork-assets.av';
import { characterizeTiff } from '../src/artwork-documentation/assets/artwork-assets.tiff';
import { validateAssetC2pa } from '../src/artwork-documentation/assets/artwork-assets.c2pa';

// Explicit opt-in: writes a full 8 GiB original plus a 134.5 MP TIFF sequentially,
// and removes only its own temporary directory. This is local capacity evidence,
// not a malware scan, an artist file, or an AWS Lambda throughput guarantee.
assert.ok(
  process.argv.includes('--write-8gib'),
  'Pass --write-8gib to run the capacity benchmark'
);
const SIZE = 8 * 1024 ** 3;
const started = Date.now();

async function main() {
  const directory = await mkdtemp(join(tmpdir(), 'artwork-capacity-'));
  const path = join(directory, 'original.mp4');
  try {
    const fixture = await readFile(
      join(
        process.cwd(),
        'src/artwork-documentation/assets/fixtures/dash-init.mp4'
      )
    );
    const free = Buffer.alloc(16);
    free.writeUInt32BE(1);
    free.write('free', 4);
    const freeSize = SIZE - fixture.length;
    free.writeUInt32BE(Math.floor(freeSize / 2 ** 32), 8);
    free.writeUInt32BE(freeSize % 2 ** 32, 12);
    const first = Buffer.concat([fixture, free]);
    const expected = createHash('sha256');
    const chunk = Buffer.alloc(4 * 1024 ** 2);
    const chunks = function* () {
      expected.update(first);
      yield first;
      for (
        let remaining = SIZE - first.length;
        remaining > 0;
        remaining -= chunk.length
      ) {
        const part = chunk.subarray(0, Math.min(remaining, chunk.length));
        expected.update(part);
        yield part;
      }
    };
    const result = await hashAssetStream(
      Readable.from(chunks()),
      SIZE,
      'mp4',
      new AbortController().signal,
      path
    );
    assert.equal(result.sha256, expected.digest('hex'));
    assert.equal((await stat(path)).size, SIZE);
    const handle = await open(path, 'r');
    let readBytes = 0;
    try {
      const properties = await characterizeMp4(
        SIZE,
        async (position, length) => {
          const buffer = Buffer.alloc(length);
          assert.equal(
            (await handle.read(buffer, 0, length, position)).bytesRead,
            length
          );
          readBytes += length;
          return buffer;
        }
      );
      assert.ok(properties?.track_count);
    } finally {
      await handle.close();
    }
    const c2pa = await validateAssetC2pa(path, 'video/mp4', result.sha256);
    assert.ok(
      ['no_manifest', 'report_available'].includes(c2pa.metadata.status)
    );
    console.log(
      JSON.stringify({
        stage: '8gib_original',
        bytes: SIZE,
        elapsed_ms: Date.now() - started,
        sha256: result.sha256,
        prefix_bytes: result.prefix.length,
        suffix_bytes: result.suffix.length,
        metadata_bytes_read: readBytes,
        c2pa_status: c2pa.metadata.status,
        c2pa_integrity: c2pa.metadata.integrity,
        process_max_rss_kib: process.resourceUsage().maxRSS,
        fixture:
          'official SDK MP4 initialization fixture plus inert free-box padding'
      })
    );
    await rm(path);
    if (c2pa.reportPath) await rm(c2pa.reportPath);
    await benchmarkTiff(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function benchmarkTiff(directory: string) {
  const started = Date.now();
  const width = 14204,
    height = 9472,
    pixelBytes = width * height * 6;
  const header = Buffer.alloc(256);
  header.write('II');
  header.writeUInt16LE(42, 2);
  header.writeUInt32LE(8, 4);
  const tags = [
    [256, 4, 1, width],
    [257, 4, 1, height],
    [258, 3, 3, 224],
    [259, 3, 1, 1],
    [262, 3, 1, 2],
    [273, 4, 1, 256],
    [277, 3, 1, 3],
    [278, 4, 1, height],
    [279, 4, 1, pixelBytes],
    [284, 3, 1, 1]
  ];
  header.writeUInt16LE(tags.length, 8);
  tags.forEach(([tag, type, count, value], index) => {
    const offset = 10 + index * 12;
    header.writeUInt16LE(tag, offset);
    header.writeUInt16LE(type, offset + 2);
    header.writeUInt32LE(count, offset + 4);
    header.writeUInt32LE(value, offset + 8);
  });
  [224, 226, 228].forEach((offset) => header.writeUInt16LE(16, offset));
  const chunk = Buffer.alloc(4 * 1024 ** 2);
  function* chunks() {
    yield header;
    for (let remaining = pixelBytes; remaining > 0; remaining -= chunk.length)
      yield chunk.subarray(0, Math.min(remaining, chunk.length));
  }
  const path = join(directory, 'original.tiff');
  const result = await hashAssetStream(
    Readable.from(chunks()),
    pixelBytes + header.length,
    'tiff',
    new AbortController().signal,
    path
  );
  const handle = await open(path, 'r');
  let readBytes = 0;
  try {
    const measured = await characterizeTiff(
      result.size,
      async (position, length) => {
        const buffer = Buffer.alloc(length);
        assert.equal(
          (await handle.read(buffer, 0, length, position)).bytesRead,
          length
        );
        readBytes += length;
        return buffer;
      }
    );
    assert.equal(measured?.width, width);
    assert.equal(measured?.height, height);
    assert.equal(measured?.bit_depth, 16);
    assert.equal(measured?.channels, 3);
    const native = await sharp(path, { limitInputPixels: false }).metadata();
    assert.equal(native.width, width);
    assert.equal(native.height, height);
    assert.equal(native.depth, 'ushort');
    assert.ok(
      result.size > PREVIEW_FILE_LIMIT && width * height > PREVIEW_PIXEL_LIMIT
    );
    const c2pa = await validateAssetC2pa(path, 'image/tiff', result.sha256);
    assert.equal(c2pa.metadata.status, 'no_manifest');
    console.log(
      JSON.stringify({
        stage: '134.5mp_16bit_rgb_tiff',
        bytes: result.size,
        width,
        height,
        elapsed_ms: Date.now() - started,
        metadata_bytes_read: readBytes,
        native_depth: native.depth,
        c2pa_status: c2pa.metadata.status,
        process_max_rss_kib: process.resourceUsage().maxRSS,
        original_preserved: true,
        fixture: 'generated uncompressed RGB TIFF; no artist content'
      })
    );
  } finally {
    await handle.close();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
