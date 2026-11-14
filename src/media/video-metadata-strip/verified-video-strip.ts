import { VideoStructureProblem } from './iso-boxes';
import { VideoMetadataFinding } from './video-metadata-policy';
import { stripVideoMetadataFile } from './video-metadata-strip';
import { VerifiedTrack, verifyVideoStrip } from './video-strip-verification';

export type VerifiedVideoStripResult =
  /** Nothing identifying: use the original file unchanged. */
  | { readonly kind: 'clean'; readonly size: number }
  /** The output file is stripped and verified against the original. */
  | {
      readonly kind: 'stripped';
      readonly findings: VideoMetadataFinding[];
      readonly removedTracks: string[];
      readonly inputBytes: number;
      readonly outputBytes: number;
      readonly tracks: VerifiedTrack[];
    }
  /** The structure is not one the rewriter supports; nothing was written. */
  | {
      readonly kind: 'unsupported';
      readonly problem: VideoStructureProblem;
      readonly detail: string;
    }
  /** A stripped file was written but did not verify; do not use it. */
  | {
      readonly kind: 'unverified';
      readonly findings: VideoMetadataFinding[];
      readonly reason: string;
    };

/**
 * Strips an MP4/QuickTime file into `outputPath` and then verifies the
 * written file against the original (see `verifyVideoStrip`). Only a
 * `stripped` result's output may be published.
 */
export async function stripVideoMetadataVerified(
  inputPath: string,
  outputPath: string
): Promise<VerifiedVideoStripResult> {
  const result = await stripVideoMetadataFile(inputPath, outputPath);
  if (result.kind !== 'stripped') return result;
  const verification = await verifyVideoStrip(inputPath, outputPath);
  if (!verification.ok) {
    return {
      kind: 'unverified',
      findings: result.findings,
      reason: verification.reason
    };
  }
  return { ...result, tracks: verification.tracks };
}
