import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Handler } from 'aws-lambda';
import sharp from 'sharp';

const ACTION = 'verify_media_dependencies_v1';

/** Direct IAM invocation only: fixed in-memory inputs, before DB/queue work. */
export function withMediaDependencySmoke(handler: Handler): Handler {
  return async (event, context, callback) => {
    if (
      event &&
      typeof event === 'object' &&
      event.operator_action === ACTION &&
      Object.keys(event).length === 1
    ) {
      return verifyMediaDependencies();
    }
    return handler(event, context, callback);
  };
}

async function verifyMediaDependencies() {
  const jpeg = await sharp({
    create: { width: 24, height: 12, channels: 3, background: '#336699' }
  })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();
  const chunks: Buffer[] = [];
  await pipeline(
    Readable.from([jpeg.subarray(0, 8), jpeg.subarray(8)]),
    sharp().rotate().resize({ height: 6 }).webp(),
    new Writable({
      write(chunk, _encoding, next) {
        chunks.push(chunk);
        next();
      }
    })
  );
  const image = await sharp(Buffer.concat(chunks)).metadata();
  assert.equal(image.width, 3);
  assert.equal(image.height, 6);
  assert.equal(image.exif, undefined);
  assert.equal(image.orientation, undefined);

  const raw = Buffer.alloc(24 * 24 * 4, 255);
  raw.fill(0, 0, 24 * 12 * 4);
  const gif = await sharp(raw, {
    raw: { width: 24, height: 24, channels: 4, pageHeight: 12 }
  })
    .gif({ delay: [80, 160], loop: 2 })
    .toBuffer();
  const resized = await sharp(gif, { animated: true })
    .resize({ height: 6 })
    .gif()
    .toBuffer();
  const animation = await sharp(resized, { animated: true }).metadata();
  assert.equal(animation.pages, 2);
  assert.equal(animation.pageHeight, 6);
  assert.equal(animation.delay?.join(','), '80,160');
  assert.equal(animation.loop, 2);
  await assert.rejects(sharp(Buffer.from('invalid-image')).metadata());
  return {
    action: ACTION,
    status: 'ok',
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    sharp: sharp.versions.sharp,
    vips: sharp.versions.vips,
    heif: sharp.versions.heif,
    checks: [
      'rotation',
      'metadata-stripping',
      'stream-completion',
      'webp',
      'gif-frames-timing',
      'malformed-image'
    ]
  };
}
