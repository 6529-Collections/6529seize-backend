import { createHash } from 'node:crypto';
import { FileHandle } from 'node:fs/promises';
import { malformed } from './iso-boxes';
import { ChunkRange } from './movie-structure';

/** Media bytes move through one buffer this size; nothing else is held. */
const IO_BUFFER_BYTES = 1024 * 1024;

/** Joins ranges that directly follow each other, keeping their order. */
export function coalesceRanges(ranges: readonly ChunkRange[]): ChunkRange[] {
  const joined: { offset: number; size: number }[] = [];
  for (const range of ranges) {
    if (!range.size) continue;
    const last = joined[joined.length - 1];
    if (last && last.offset + last.size === range.offset) {
      last.size += range.size;
    } else {
      joined.push({ offset: range.offset, size: range.size });
    }
  }
  return joined;
}

/** Calls `use` with each piece of the ranges, in order. */
async function readRanges(
  file: FileHandle,
  ranges: readonly ChunkRange[],
  use: (piece: Buffer) => Promise<void> | void
): Promise<void> {
  const buffer = Buffer.alloc(IO_BUFFER_BYTES);
  for (const range of coalesceRanges(ranges)) {
    let done = 0;
    while (done < range.size) {
      const length = Math.min(buffer.length, range.size - done);
      const { bytesRead } = await file.read(
        buffer,
        0,
        length,
        range.offset + done
      );
      if (bytesRead === 0) throw malformed('a sample runs past the file end');
      await use(buffer.subarray(0, bytesRead));
      done += bytesRead;
    }
  }
}

/** Writes all of `bytes` at `position`; returns the position after them. */
export async function writeAt(
  file: FileHandle,
  bytes: Buffer,
  position: number
): Promise<number> {
  let done = 0;
  while (done < bytes.length) {
    const { bytesWritten } = await file.write(
      bytes,
      done,
      bytes.length - done,
      position + done
    );
    done += bytesWritten;
  }
  return position + bytes.length;
}

/** Copies the ranges, in order, to `to` from `position`; returns the end. */
export async function copyRanges(
  from: FileHandle,
  to: FileHandle,
  ranges: readonly ChunkRange[],
  position: number
): Promise<number> {
  let at = position;
  await readRanges(from, ranges, async (piece) => {
    at = await writeAt(to, piece, at);
  });
  return at;
}

/** SHA-256 (hex) of the ranges' bytes, concatenated in order. */
export async function hashRanges(
  file: FileHandle,
  ranges: readonly ChunkRange[]
): Promise<string> {
  const hash = createHash('sha256');
  await readRanges(file, ranges, (piece) => {
    hash.update(piece);
  });
  return hash.digest('hex');
}
