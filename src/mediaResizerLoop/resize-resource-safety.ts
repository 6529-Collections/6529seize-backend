import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import Sharp, { Metadata } from 'sharp';

// This Lambda handles one resize per invocation; retaining decoded operations or
// open temporary files between requests consumes its fixed resource budget.
Sharp.cache(false);

// The production function has 1028 MiB RAM and at least 512 MiB temporary disk.
// Keep half of each for the runtime, codec/encoder overhead and multipart upload.
export const MAX_SOURCE_BYTES = 256 * 1024 * 1024;
export const MAX_DECODED_WORK_BYTES = 512 * 1024 * 1024;
export const INPUT_PIXEL_BACKSTOP = 1_000_000_000;

type InputFailureCode =
  | 'SOURCE_TOO_LARGE'
  | 'DECODED_IMAGE_TOO_LARGE'
  | 'INVALID_IMAGE';

export class UnprocessableResizeInput extends Error {
  constructor(readonly code: InputFailureCode) {
    super(code);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'UnprocessableResizeInput';
  }
}

/** Conservative admission estimate, not a guarantee about native codec memory. */
export function assertDecodedWorkBudget(metadata: Metadata, animated: boolean) {
  const pages = animated ? (metadata.pages ?? 1) : 1;
  // If per-frame height is absent, the reported height is a conservative bound;
  // still multiply by every page rather than risk admitting uncounted frames.
  const height =
    animated && pages > 1
      ? (metadata.pageHeight ?? metadata.height)
      : metadata.height;
  const sampleBytes: Record<string, number> = {
    char: 1,
    uchar: 1,
    short: 2,
    ushort: 2,
    int: 4,
    uint: 4,
    float: 4,
    double: 8,
    complex: 8,
    dpcomplex: 16
  };
  const values = [metadata.width, height, pages, metadata.channels];
  const bytesPerSample = sampleBytes[metadata.depth];
  if (
    values.some((value) => !Number.isSafeInteger(value) || value! < 1) ||
    !bytesPerSample
  ) {
    throw new UnprocessableResizeInput('INVALID_IMAGE');
  }
  // Include every GIF frame, conversion to at least RGBA and four working copies.
  const estimatedBytes =
    metadata.width! *
    height! *
    pages *
    Math.max(4, metadata.channels!) *
    bytesPerSample *
    4;
  if (
    !Number.isSafeInteger(estimatedBytes) ||
    estimatedBytes > MAX_DECODED_WORK_BYTES
  )
    throw new UnprocessableResizeInput('DECODED_IMAGE_TOO_LARGE');
}

export function isUnprocessableResizeInput(error: unknown): boolean {
  // Native decoder messages are version-specific. Unmatched failures deliberately
  // propagate as operational errors rather than being cached as invalid input.
  return (
    error instanceof UnprocessableResizeInput ||
    (error instanceof Error &&
      /Input (?:file contains unsupported image format|file has corrupt header|image exceeds pixel limit)|VipsJpeg:|jpegload:|pngload:|gifload:|webpload:|tiffload:|heifload:/i.test(
        error.message
      ))
  );
}

/** Sharp retains and concatenates stream input; a file avoids those full copies. */
export async function withResizeInputFile<T>(
  source: Readable,
  contentLength: number | undefined,
  animated: boolean,
  useFile: (path: string) => Promise<T>
): Promise<T> {
  // S3 can fail before pipeline attaches its listeners, including while mkdtemp
  // is pending or after an early destroy. Keep the original failure until close.
  let sourceError = source.errored;
  const captureSourceError = (error: Error) => {
    sourceError ??= error;
  };
  source.on('error', captureSourceError);
  source.once('close', () =>
    source.removeListener('error', captureSourceError)
  );
  if (contentLength !== undefined && contentLength > MAX_SOURCE_BYTES) {
    source.destroy();
    throw new UnprocessableResizeInput('SOURCE_TOO_LARGE');
  }
  const directory = await mkdtemp(join(tmpdir(), '6529-resize-')).catch(
    (error) => {
      source.destroy();
      throw error;
    }
  );
  const path = join(directory, 'source');
  let receivedBytes = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      receivedBytes += chunk.length;
      if (receivedBytes > MAX_SOURCE_BYTES) {
        callback(new UnprocessableResizeInput('SOURCE_TOO_LARGE'));
        return;
      }
      callback(null, chunk);
    }
  });
  // Only the unique directory created by this invocation is removed.
  const cleanup = () => rm(directory, { recursive: true, force: true });
  let result: T;
  try {
    if (sourceError) throw sourceError;
    await pipeline(source, limit, createWriteStream(path));
    const metadata = await Sharp(path, {
      failOn: 'none',
      animated,
      limitInputPixels: INPUT_PIXEL_BACKSTOP
    }).metadata();
    assertDecodedWorkBudget(metadata, animated);
    result = await useFile(path);
  } catch (error) {
    // A secondary cleanup failure must not change input classification or hide
    // the original source/upload error. Cleanup-only failures still propagate.
    await cleanup().catch(() => undefined);
    throw error;
  }
  await cleanup();
  return result;
}
