import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const MAX_SOURCE_BYTES = 256 * 1024 * 1024;

export type InputFailureCode =
  | 'OUTPUT_TOO_LARGE'
  | 'SOURCE_TOO_LARGE'
  | 'DECODED_IMAGE_TOO_LARGE'
  | 'INVALID_IMAGE'
  | 'HEIC_DECODE_FAILED'
  | 'UNSUPPORTED_CODEC';

export class UnprocessableResizeInput extends Error {
  constructor(readonly code: InputFailureCode) {
    super(code);
    Object.setPrototypeOf(this, new.target.prototype);
    this.name = 'UnprocessableResizeInput';
  }
}

/** Own the source and generated files for the entire resize/upload operation. */
export async function withResizeSourceFile<T>(
  source: Readable,
  contentLength: number | undefined,
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
    if (contentLength !== undefined && receivedBytes !== contentLength) {
      throw new Error('RESIZE_SOURCE_LENGTH_MISMATCH');
    }
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
