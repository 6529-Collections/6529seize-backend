import { dirname, join } from 'node:path';
import { stripVideoMetadataVerified } from '@/media/video-metadata-strip/verified-video-strip';

/** Shown to the uploader when a chat video cannot be stripped. */
export const VIDEO_METADATA_NOT_REMOVED_MESSAGE =
  'Location and other identifying details could not be removed from this video, so it was not posted. Save or export it again as an MP4 or MOV file and upload it again.';

export const VIDEO_TOO_LARGE_MESSAGE = 'Videos can be at most 500 MiB.';

export type PreparedChatVideo =
  | {
      readonly kind: 'publish';
      /** The stripped copy, or the original when it had nothing to strip. */
      readonly path: string;
      /** One line for the log; never contains metadata values. */
      readonly summary: string;
    }
  | {
      readonly kind: 'reject';
      /** Why, for the log; the uploader sees the fixed message above. */
      readonly reason: string;
      /** A failed verification is a bug worth an error; a format is not. */
      readonly verificationFailed: boolean;
    };

/**
 * Strips identifying metadata from a chat video on disk, losslessly: only
 * its audio and video tracks are kept, their samples byte for byte, and the
 * written file is verified against the original before it may be
 * published. A video that cannot be stripped and verified is rejected,
 * never published with its metadata.
 */
export async function prepareChatVideoFile(
  sourcePath: string
): Promise<PreparedChatVideo> {
  const outputPath = join(dirname(sourcePath), 'stripped-video');
  const result = await stripVideoMetadataVerified(sourcePath, outputPath);
  switch (result.kind) {
    case 'clean':
      return {
        kind: 'publish',
        path: sourcePath,
        summary: `no identifying metadata (${result.size} bytes)`
      };
    case 'stripped':
      return {
        kind: 'publish',
        path: outputPath,
        summary: `removed ${result.findings.join(', ')}; dropped tracks [${result.removedTracks.join(', ')}]; kept ${result.tracks
          .map((track) => `${track.handler}:${track.codecs.join('+')}`)
          .join(', ')}; ${result.inputBytes} -> ${result.outputBytes} bytes`
      };
    case 'unsupported':
      return {
        kind: 'reject',
        reason: `unsupported video structure (${result.detail})`,
        verificationFailed: false
      };
    case 'unverified':
      return {
        kind: 'reject',
        reason: `stripped video did not verify (${result.reason})`,
        verificationFailed: true
      };
  }
}
