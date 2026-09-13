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
  const height = animated && pages > 1 ? metadata.pageHeight : metadata.height;
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
  try {
    await pipeline(source, limit, createWriteStream(path));
    const metadata = await Sharp(path, {
      failOn: 'none',
      animated,
      limitInputPixels: INPUT_PIXEL_BACKSTOP
    }).metadata();
    assertDecodedWorkBudget(metadata, animated);
    return await useFile(path);
  } finally {
    // Only the unique directory created by this invocation is removed.
    await rm(directory, { recursive: true, force: true });
  }
}
