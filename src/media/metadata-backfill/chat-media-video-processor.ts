import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DROP_MEDIA_MAX_VIDEO_BYTES } from '@/drops/drop-media-upload.config';
import { VideoStructureProblem } from '@/media/video-metadata-strip/iso-boxes';
import {
  stripVideoMetadataVerified,
  VerifiedVideoStripResult
} from '@/media/video-metadata-strip/verified-video-strip';
import { VideoMetadataFinding } from '@/media/video-metadata-strip/video-metadata-policy';
import {
  fileBody,
  replaceInPlace,
  ReplacementWriter
} from './backfill-replacement';
import {
  MediaObjectStore,
  ObjectChangedError,
  ObjectHead,
  ObjectTooLargeError
} from './backfill-storage';
import { ChatMediaTarget } from './chat-media-candidates';
import { isEncoded, ObjectSkipReason } from './chat-media-object-processor';

/** Default `--max-video-bytes`: the 500 MiB upload limit for videos. */
export const BACKFILL_MAX_VIDEO_BYTES = DROP_MEDIA_MAX_VIDEO_BYTES;

export type VideoOutcome =
  | {
      readonly kind: 'skipped';
      readonly reason: ObjectSkipReason;
      readonly findings: VideoMetadataFinding[];
      readonly size: number;
      /** Set for unsupported structures. */
      readonly problem?: VideoStructureProblem;
    }
  | { readonly kind: 'clean'; readonly size: number }
  | {
      readonly kind: 'rewrite';
      readonly findings: VideoMetadataFinding[];
      readonly originalSize: number;
      readonly strippedSize: number;
      /** False in a dry run. */
      readonly written: boolean;
    };

export interface VideoProcessorDeps {
  readonly publicStore: MediaObjectStore;
  /** Null in a dry run: nothing is ever written then. */
  readonly writer: ReplacementWriter | null;
  readonly runId: string;
  readonly now: () => Date;
  /** Larger objects are skipped as too large. */
  readonly maxVideoBytes?: number;
  /** Parent directory for each video's temporary files. */
  readonly tempDirectory?: string;
}

function skipped(
  reason: ObjectSkipReason,
  size: number,
  findings: VideoMetadataFinding[] = [],
  problem?: VideoStructureProblem
): VideoOutcome {
  return { kind: 'skipped', reason, findings, size, problem };
}

/** An unsupported structure, by the skip reason images use where one fits. */
function unsupportedReason(problem: VideoStructureProblem): ObjectSkipReason {
  if (problem === VideoStructureProblem.NOT_ISO_MEDIA) {
    return ObjectSkipReason.UNSUPPORTED_FORMAT;
  }
  if (problem === VideoStructureProblem.MALFORMED) {
    return ObjectSkipReason.UNPARSEABLE_CONTAINER;
  }
  return ObjectSkipReason.UNSUPPORTED_VIDEO_STRUCTURE;
}

/**
 * Inspects one public chat video and, only when it carries identifying
 * metadata and the lossless strip verifies (see `stripVideoMetadataVerified`),
 * replaces it in place exactly like an image: a verified private safety copy
 * and manifest first, then a conditional overwrite of the same key with the
 * same headers. The video goes through temporary files, never memory, so
 * each one in flight needs about twice its size in temporary disk space.
 */
export class ChatMediaVideoProcessor {
  private readonly maxVideoBytes: number;

  constructor(private readonly deps: VideoProcessorDeps) {
    this.maxVideoBytes = deps.maxVideoBytes ?? BACKFILL_MAX_VIDEO_BYTES;
  }

  async processVideo(target: ChatMediaTarget): Promise<VideoOutcome> {
    const head = await this.deps.publicStore.head(target.key);
    if (!head) return skipped(ObjectSkipReason.MISSING_OBJECT, 0);
    if (isEncoded(head)) {
      return skipped(ObjectSkipReason.CONTENT_ENCODED, head.size);
    }
    if (head.size > this.maxVideoBytes) {
      return skipped(ObjectSkipReason.TOO_LARGE, head.size);
    }
    const directory = await mkdtemp(
      join(this.deps.tempDirectory ?? tmpdir(), '6529-video-backfill-')
    );
    try {
      return await this.processInDirectory(target, head, directory);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async processInDirectory(
    target: ChatMediaTarget,
    head: ObjectHead,
    directory: string
  ): Promise<VideoOutcome> {
    const source = join(directory, 'original');
    const output = join(directory, 'stripped');
    try {
      await this.deps.publicStore.downloadToFile(target.key, source, {
        ifMatch: head.etag,
        maxBytes: this.maxVideoBytes
      });
    } catch (error) {
      if (error instanceof ObjectChangedError) {
        return skipped(ObjectSkipReason.CHANGED_DURING_RUN, head.size);
      }
      if (error instanceof ObjectTooLargeError) {
        return skipped(ObjectSkipReason.TOO_LARGE, head.size);
      }
      throw error;
    }
    const result = await stripVideoMetadataVerified(source, output);
    return this.handleResult(target, head, result, source, output);
  }

  private async handleResult(
    target: ChatMediaTarget,
    head: ObjectHead,
    result: VerifiedVideoStripResult,
    source: string,
    output: string
  ): Promise<VideoOutcome> {
    switch (result.kind) {
      case 'clean':
        return { kind: 'clean', size: head.size };
      case 'unsupported':
        return skipped(
          unsupportedReason(result.problem),
          head.size,
          [],
          result.problem
        );
      case 'unverified':
        return skipped(
          ObjectSkipReason.VERIFICATION_FAILED,
          head.size,
          result.findings
        );
      case 'stripped':
        return this.rewrite(target, head, result, source, output);
    }
  }

  private async rewrite(
    target: ChatMediaTarget,
    head: ObjectHead,
    result: Extract<VerifiedVideoStripResult, { kind: 'stripped' }>,
    source: string,
    output: string
  ): Promise<VideoOutcome> {
    const outcome = {
      kind: 'rewrite' as const,
      findings: result.findings,
      originalSize: result.inputBytes,
      strippedSize: result.outputBytes
    };
    const writer = this.deps.writer;
    if (!writer) return { ...outcome, written: false };
    try {
      await replaceInPlace(target, {
        writer,
        publicStore: this.deps.publicStore,
        runId: this.deps.runId,
        now: this.deps.now,
        key: target.key,
        head,
        original: await fileBody(source),
        stripped: await fileBody(output)
      });
    } catch (error) {
      if (error instanceof ObjectChangedError) {
        return skipped(
          ObjectSkipReason.CHANGED_DURING_RUN,
          head.size,
          result.findings
        );
      }
      throw error;
    }
    return { ...outcome, written: true };
  }
}
