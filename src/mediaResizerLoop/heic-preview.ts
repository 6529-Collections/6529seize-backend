import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import type { Metadata } from 'sharp';
import { UnprocessableResizeInput } from '@/mediaResizerLoop/resize-resource-safety';

export const HEIC_DECODER_POLICY = 'libheif-js-1.23.5-jpeg-v1';
const MAX_HEIC_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_HEIC_PIXELS = 32 * 1024 * 1024;
const MAX_SECONDS = 20;
const UPLOAD_RESERVE_MS = 2000;

// Static child source; paths and resize options are argv, never executable input.
// WASM memory (512 MiB), JS heap (256 MiB), pixels, input bytes and lifetime are
// bounded independently. The decoder's allocations die with this process.
// Only explicit libheif input/codec failures are permanent. Module loading, I/O,
// allocation, unexpected exceptions and worker termination stay operational.
export const HEIC_PREVIEW_SCRIPT = `
const fs = require('node:fs');
const reject = code => { process.stdout.write(code); process.exit(0); };
const check = error => {
  if (error.code.value === 0) return;
  if ([2, 3, 4, 7].includes(error.code.value)) reject('HEIC_DECODE_FAILED');
  throw new Error('HEIC_DECODER_RUNTIME_ERROR');
};
const checkPixels = (width, height) => {
  if (![width, height].every(n => Number.isSafeInteger(n) && n > 0))
    reject('HEIC_DECODE_FAILED');
  if (width * height > ${MAX_HEIC_PIXELS}) reject('DECODED_IMAGE_TOO_LARGE');
};
(async () => {
  const heif = await require(process.argv[1])();
  const sharp = require(process.argv[2]);
  sharp.cache(false);
  if (fs.statSync(process.argv[3]).size > ${MAX_HEIC_SOURCE_BYTES}) reject('SOURCE_TOO_LARGE');
  const bytes = fs.readFileSync(process.argv[3]);
  const context = heif.heif_context_alloc();
  if (!context) throw new Error('HEIC_DECODER_CONTEXT_UNAVAILABLE');
  check(heif.heif_context_read_from_memory(context, bytes));
  const ids = heif.heif_js_context_get_list_of_top_level_image_IDs(context);
  if (!Array.isArray(ids) || !ids.length) reject('HEIC_DECODE_FAILED');
  let handle;
  for (const id of ids) {
    const candidate = heif.heif_js_context_get_image_handle(context, id);
    if (candidate?.code) { check(candidate); continue; }
    if (heif.heif_image_handle_is_primary_image(candidate)) { handle = candidate; break; }
    heif.heif_image_handle_release(candidate);
  }
  if (!handle) reject('HEIC_DECODE_FAILED');
  checkPixels(heif.heif_image_handle_get_width(handle), heif.heif_image_handle_get_height(handle));
  const decoded = await heif.heif_js_decode_image2(handle,
    heif.heif_colorspace.heif_colorspace_RGB, heif.heif_chroma.heif_chroma_interleaved_RGBA);
  if (decoded?.code) check(decoded);
  const plane = decoded.channels?.find(channel => channel.id === heif.heif_channel.heif_channel_interleaved);
  if (!plane) throw new Error('HEIC_DECODER_OUTPUT_UNAVAILABLE');
  const { width, height, stride } = plane;
  checkPixels(width, height);
  if (stride < width * 4 || plane.data.length < stride * height)
    throw new Error('HEIC_DECODER_OUTPUT_INCOMPLETE');
  const pixels = Buffer.alloc(width * height * 4);
  for (let row = 0; row < height; row++)
    pixels.set(plane.data.subarray(row * stride, row * stride + width * 4), row * width * 4);
  heif.heif_image_release(decoded.image);
  heif.heif_image_handle_release(handle);
  heif.heif_context_free(context);
  // libheif applies HEIF item transforms; do not rotate those pixels twice.
  const target = JSON.parse(process.argv[5]);
  await sharp(pixels, { raw: { width, height, channels: 4 } })
    .resize(target.width, target.height, { fit: target.fit, withoutEnlargement: true })
    .flatten({ background: '#ffffff' }).jpeg({ quality: 85 })
    .toFile(process.argv[4]);
  process.stdout.write('OK');
})().catch(() => { process.stderr.write('HEIC_CONVERSION_WORKER_FAILED'); process.exitCode = 1; });
`;

export function isHeic(metadata: Metadata): boolean {
  return metadata.format === 'heif' && metadata.compression === 'hevc';
}

/** Call inside withResizeInputFile so source and output share its cleanup scope. */
export async function prepareHeicPreview(
  inputPath: string,
  target: {
    width: number | null;
    height: number | null;
    fit: 'cover' | 'inside' | 'outside';
  },
  remainingTimeMs = MAX_SECONDS * 1000 + UPLOAD_RESERVE_MS
): Promise<string> {
  const timeout = Math.min(
    MAX_SECONDS * 1000,
    remainingTimeMs - UPLOAD_RESERVE_MS
  );
  if (timeout < 1000) throw new Error('HEIC_CONVERSION_DEADLINE_EXCEEDED');
  const outputPath = join(dirname(inputPath), 'heic-preview.jpg');
  await new Promise<void>((resolve, reject) => {
    execFile(
      process.execPath,
      [
        '--max-old-space-size=256',
        '--wasm-max-mem-pages=8192',
        '-e',
        HEIC_PREVIEW_SCRIPT,
        require.resolve('libheif-js/libheif-wasm/libheif-bundle.js'),
        require.resolve('sharp'),
        inputPath,
        outputPath,
        JSON.stringify(target)
      ],
      {
        windowsHide: true,
        timeout,
        killSignal: 'SIGKILL',
        maxBuffer: 4096,
        encoding: 'utf8'
      },
      (error, stdout) => {
        if (error) {
          reject(
            new Error(
              error.killed
                ? 'HEIC_CONVERSION_DEADLINE_EXCEEDED'
                : 'HEIC_CONVERSION_WORKER_FAILED'
            )
          );
        } else if (stdout === 'OK') {
          resolve();
        } else if (
          stdout === 'HEIC_DECODE_FAILED' ||
          stdout === 'DECODED_IMAGE_TOO_LARGE' ||
          stdout === 'SOURCE_TOO_LARGE'
        ) {
          reject(new UnprocessableResizeInput(stdout));
        } else {
          reject(new Error('HEIC_CONVERSION_INVALID_WORKER_RESPONSE'));
        }
      }
    );
  });
  return outputPath;
}
