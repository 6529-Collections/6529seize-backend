import * as MP4Box from 'mp4box';
import { ArchiveRangeReader } from '@/artwork-documentation/assets/artwork-assets.archive';
import { AssetInspectionError } from '@/artwork-documentation/assets/artwork-assets.inspection';

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
      const file = MP4Box.createFile(false);
      let result: Record<string, string | number | null> | null = null;
      let invalid = false;
      file.onReady = (info: Movie) => {
        result = properties(info);
      };
      file.onError = () => {
        invalid = true;
      };
      const buffer = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.length
      ) as ArrayBuffer & { fileStart: number };
      buffer.fileStart = 0;
      try {
        file.appendBuffer(buffer as never);
        file.flush();
      } catch {
        throw new AssetInspectionError('INVALID_MEDIA_CONTAINER');
      }
      if (invalid) throw new AssetInspectionError('INVALID_MEDIA_CONTAINER');
      return result;
    }
    offset += length;
  }
  return null;
}
