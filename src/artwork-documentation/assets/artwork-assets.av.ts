import { execFile } from 'node:child_process';
import { ArchiveRangeReader } from '@/artwork-documentation/assets/artwork-assets.archive';
import { AssetInspectionError } from '@/artwork-documentation/assets/artwork-assets.inspection';
import { validateMp4Tables } from '@/artwork-documentation/assets/artwork-assets-mp4-budget';

type Track = {
  id: number;
  type?: string;
  codec?: string;
  duration?: number;
  timescale?: number;
  nb_samples?: number;
  video?: { width?: number; height?: number };
  audio?: {
    sample_rate?: number;
    channel_count?: number;
    sample_size?: number;
  };
};
type Movie = { duration?: number; timescale?: number; tracks?: Track[] };

// Static child source. Untrusted bytes arrive only on stdin; no artwork is executed.
// MP4Box expands compressed sample counts, so its heap and synchronous work must
// not share the Lambda process. A budget failure leaves characterization partial.
const MP4_READER_SCRIPT = `
const { createFile } = require('mp4box');
const chunks = [];
let length = 0;
process.stdin.on('data', chunk => {
  length += chunk.length;
  if (length > 8 * 1024 ** 2 + 65536) process.exit(2);
  chunks.push(chunk);
});
process.stdin.on('end', () => {
  try {
    const bytes = Buffer.concat(chunks);
    const file = createFile(false);
    let result = null;
    file.onError = () => { process.exit(2); };
    file.onReady = info => {
      if (info.tracks.length > 64) return;
      result = { duration: info.duration, timescale: info.timescale, tracks: info.tracks.map(track => ({
        id: track.id, type: track.type, codec: String(track.codec ?? '').slice(0, 400),
        duration: track.duration, timescale: track.timescale, nb_samples: track.nb_samples,
        video: track.video, audio: track.audio
      })) };
    };
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length);
    buffer.fileStart = 0;
    file.appendBuffer(buffer);
    file.flush();
    process.stdout.write(JSON.stringify(result));
  } catch { process.exit(2); }
});
`;

async function inspectMovie(bytes: Buffer): Promise<Movie | null> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      ['--max-old-space-size=128', '-e', MP4_READER_SCRIPT],
      {
        windowsHide: true,
        timeout: 10_000,
        killSignal: 'SIGKILL',
        maxBuffer: 64 * 1024,
        encoding: 'utf8'
      },
      (error, stdout) => {
        if (error?.code === 2) {
          reject(new AssetInspectionError('INVALID_MEDIA_CONTAINER'));
        } else if (error) {
          resolve(null);
        } else {
          try {
            resolve(JSON.parse(stdout) as Movie | null);
          } catch {
            resolve(null);
          }
        }
      }
    );
    // A parser that exits early can close the pipe before the bounded input is sent.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(bytes);
  });
}

function properties(info: Movie): Record<string, string | number | null> {
  const result: Record<string, string | number | null> = {
    duration_seconds: info.timescale
      ? Number(info.duration) / info.timescale
      : null,
    track_count: info.tracks?.length ?? 0
  };
  (info.tracks ?? []).forEach((track, index) => {
    const duration = track.timescale
      ? Number(track.duration) / track.timescale
      : null;
    Object.assign(result, {
      [`track_${index}_codec`]: track.codec ?? null,
      [`track_${index}_type`]: track.type ?? null,
      [`track_${index}_duration_seconds`]: duration
    });
    if (track.video)
      Object.assign(result, {
        [`track_${index}_width`]: track.video.width ?? null,
        [`track_${index}_height`]: track.video.height ?? null,
        [`track_${index}_average_frame_rate`]:
          duration && track.nb_samples ? track.nb_samples / duration : null
      });
    if (track.audio)
      Object.assign(result, {
        [`track_${index}_sample_rate_hz`]: track.audio.sample_rate ?? null,
        [`track_${index}_channels`]: track.audio.channel_count ?? null,
        [`track_${index}_bit_depth`]: track.audio.sample_size ?? null
      });
  });
  return result;
}

/** Read bounded container metadata, skipping media bytes; never decode media or fetch track URLs. */
export async function characterizeMp4(
  size: number,
  read: ArchiveRangeReader
): Promise<Record<string, string | number | null> | null> {
  let offset = 0;
  let fileType: Buffer | undefined;
  for (let count = 0; offset + 8 <= size && count < 1024; count++) {
    const header = await read(offset, Math.min(16, size - offset));
    if (header.length < 8)
      throw new AssetInspectionError('INVALID_MEDIA_CONTAINER');
    const shortSize = header.readUInt32BE(0);
    if (shortSize === 1 && header.length < 16)
      throw new AssetInspectionError('INVALID_MEDIA_CONTAINER');
    const length =
      shortSize === 1
        ? header.readUInt32BE(8) * 2 ** 32 + header.readUInt32BE(12)
        : shortSize || size - offset;
    if (
      !Number.isSafeInteger(length) ||
      length < (shortSize === 1 ? 16 : 8) ||
      offset + length > size
    )
      throw new AssetInspectionError('INVALID_MEDIA_CONTAINER');
    if (header.toString('ascii', 4, 8) === 'ftyp') {
      if (length > 65536) return null;
      fileType = await read(offset, length);
    }
    if (header.toString('ascii', 4, 8) === 'moov') {
      if (length > 8 * 1024 ** 2) return null;
      if (!fileType) return null;
      const bytes = Buffer.concat([fileType, await read(offset, length)]);
      validateMp4Tables(bytes, size);
      const result = await inspectMovie(bytes);
      return result ? properties(result) : null;
    }
    offset += length;
  }
  return null;
}
