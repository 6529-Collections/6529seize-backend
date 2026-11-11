import { CustomApiCompliantException, ForbiddenException } from '@/exceptions';
import {
  MediaUploadBudgetEntryEntity,
  MediaUploadBudgetSource
} from '@/entities/IMediaUploadBudget';
import {
  MediaUploadBudgetDb,
  mediaUploadBudgetDb,
  PendingMediaUploadSize
} from '@/media/media-upload-budget.db';
import { ObjectSizeRead, readObjectSize } from '@/media/object-size';
import { MAX_SOURCE_BYTES } from '@/media/resize-input';
import { isImageMimeType } from '@/drops/drop-media-upload.config';
import { MAX_CSV_BYTES, MAX_PDF_BYTES } from '@/attachments/attachment-limits';
import { getAttachmentsS3 } from '@/attachments/attachments-s3-client';
import { getS3 } from '@/s3.client';
import { MAX_DIRECT_MULTIPART_MEDIA_BYTES } from '@/api/media/media-upload-limits';
import { Logger } from '@/logging';
import { Time } from '@/time';

const GIB = 1024 * 1024 * 1024;
const MINUTE_MS = 60 * 1000;
export const MEDIA_UPLOAD_BUDGET_WINDOW_MS = 24 * 60 * MINUTE_MS;
/**
 * Entries without a recorded size are read from S3 once this old: a
 * single-PUT URL is valid for 15 minutes, and a multipart completion records
 * the size itself.
 */
export const PENDING_SIZE_READ_AFTER_MS = 30 * MINUTE_MS;
/**
 * A missing object counts nothing only once its upload can no longer be in
 * progress: single-PUT URLs expire after 15 minutes and part URLs after an
 * hour, and a transfer started before then has had time to finish. A
 * completion that still arrives later records the real size.
 */
export const PENDING_MISSING_SETTLES_AFTER_MS = 2 * 60 * MINUTE_MS;
/** An entry a read could not settle is read again after this. */
export const PENDING_SIZE_RECHECK_AFTER_MS = 10 * MINUTE_MS;
const PENDING_SIZES_PER_RESERVATION = 5;
const PRUNE_BATCH = 1000;
const PRUNE_PROBABILITY = 0.01;

export interface MediaUploadBudgetLimits {
  /** Uploads a profile may prepare per rolling 24 hours. */
  readonly uploadsPerDay: number;
  /** Bytes a profile may upload per rolling 24 hours. */
  readonly bytesPerDay: number;
}

export const DEFAULT_MEDIA_UPLOAD_BUDGET: MediaUploadBudgetLimits = {
  uploadsPerDay: 500,
  bytesPerDay: 20 * GIB
};

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function mediaUploadBudgetLimitsFrom(
  source: Record<string, string | undefined>
): MediaUploadBudgetLimits {
  return {
    uploadsPerDay: positiveInteger(
      source.MEDIA_UPLOAD_BUDGET_UPLOADS_PER_DAY,
      DEFAULT_MEDIA_UPLOAD_BUDGET.uploadsPerDay
    ),
    bytesPerDay: positiveInteger(
      source.MEDIA_UPLOAD_BUDGET_BYTES_PER_DAY,
      DEFAULT_MEDIA_UPLOAD_BUDGET.bytesPerDay
    )
  };
}

/**
 * The largest upload allowed for a kind of upload. Clients do not declare
 * sizes, so an upload counts this much until its size is known.
 */
export function maxUploadBytes(
  source: MediaUploadBudgetSource,
  contentType: string
): number {
  if (source === MediaUploadBudgetSource.ATTACHMENT) {
    if (contentType === 'application/pdf') return MAX_PDF_BYTES;
    if (contentType === 'text/csv') return MAX_CSV_BYTES;
    return Math.max(MAX_PDF_BYTES, MAX_CSV_BYTES);
  }
  return isImageMimeType(contentType)
    ? MAX_SOURCE_BYTES
    : MAX_DIRECT_MULTIPART_MEDIA_BYTES;
}

export const MEDIA_UPLOAD_BUDGET_EXCEEDED = 'MEDIA_UPLOAD_BUDGET_EXCEEDED';

/** Reads a stored object's size; throws when the answer is inconclusive. */
export type ObjectSizeReader = (key: string) => Promise<ObjectSizeRead>;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function defaultObjectSizeReaders(): Record<
  MediaUploadBudgetSource,
  ObjectSizeReader
> {
  const publicMedia: ObjectSizeReader = (key) =>
    readObjectSize(getS3(), requiredEnv('S3_BUCKET'), key);
  return {
    [MediaUploadBudgetSource.DROP]: publicMedia,
    [MediaUploadBudgetSource.WAVE]: publicMedia,
    [MediaUploadBudgetSource.ATTACHMENT]: (key) =>
      readObjectSize(
        getAttachmentsS3(),
        requiredEnv('ATTACHMENTS_INGEST_S3_BUCKET'),
        key
      )
  };
}

/**
 * A per-profile rolling budget for public drop/wave media and attachment
 * uploads, modelled on the E2EE blob quota: every prepared upload is a row,
 * reservations for one profile are serialized by locking its profiles row,
 * and usage is summed over the last 24 hours.
 *
 * An upload counts the largest size allowed for its kind until its size is
 * known, so uploads in progress and sizes that cannot be read are never
 * undercounted. A completion call records the size. Otherwise the entry
 * stays pending with its object key, and a later preparation by the same
 * profile reads the size from S3: a size settles it, a missing object
 * settles it at 0 once the upload can no longer be in progress, and an
 * inconclusive read leaves it pending to be read again.
 */
export class MediaUploadBudgetService {
  private readonly logger = Logger.get(this.constructor.name);

  constructor(
    private readonly db: MediaUploadBudgetDb = mediaUploadBudgetDb,
    private readonly limits: () => MediaUploadBudgetLimits = () =>
      mediaUploadBudgetLimitsFrom(process.env),
    private readonly random: () => number = Math.random,
    private readonly readers: Record<
      MediaUploadBudgetSource,
      ObjectSizeReader
    > = defaultObjectSizeReaders()
  ) {}

  /**
   * Counts one prepared upload, stored at `objectKey`, against the profile's
   * budget, or refuses it with 429 MEDIA_UPLOAD_BUDGET_EXCEEDED. The caller
   * releases the reservation if it cannot prepare the upload.
   */
  async reserve({
    id,
    profileId,
    source,
    objectKey,
    contentType
  }: {
    id: string;
    profileId: string;
    source: MediaUploadBudgetSource;
    objectKey: string;
    contentType: string;
  }): Promise<void> {
    const now = Time.currentMillis();
    const since = now - MEDIA_UPLOAD_BUDGET_WINDOW_MS;
    await this.settlePendingSizes(profileId, since, now);
    const limits = this.limits();
    const reservedBytes = maxUploadBytes(source, contentType);
    await this.db.executeNativeQueriesInTransaction(async (connection) => {
      if (!(await this.db.lockProfile(profileId, connection))) {
        // Without a profiles row nothing serializes the reservations.
        throw new ForbiddenException('Please create a profile first');
      }
      const usage = await this.db.usageSince(profileId, since, connection);
      const retryAfterSeconds =
        usage.oldestAt === null
          ? 0
          : Math.max(
              1,
              Math.ceil(
                (usage.oldestAt + MEDIA_UPLOAD_BUDGET_WINDOW_MS - now) / 1000
              )
            );
      if (usage.uploads >= limits.uploadsPerDay) {
        throw new CustomApiCompliantException(
          429,
          `Upload limit reached: at most ${limits.uploadsPerDay} uploads per 24 hours`,
          MEDIA_UPLOAD_BUDGET_EXCEEDED,
          {
            limit: 'uploads',
            max_uploads: limits.uploadsPerDay,
            window_hours: 24,
            retry_after_seconds: retryAfterSeconds
          }
        );
      }
      if (usage.bytes + reservedBytes > limits.bytesPerDay) {
        throw new CustomApiCompliantException(
          429,
          `Upload limit reached: at most ${formatBytes(limits.bytesPerDay)} per 24 hours`,
          MEDIA_UPLOAD_BUDGET_EXCEEDED,
          {
            limit: 'bytes',
            max_bytes: limits.bytesPerDay,
            window_hours: 24,
            retry_after_seconds: retryAfterSeconds
          }
        );
      }
      const entry: MediaUploadBudgetEntryEntity = {
        id,
        profile_id: profileId,
        source,
        created_at: now,
        size_bytes: null,
        reserved_bytes: reservedBytes,
        pending_object_key: objectKey,
        size_checked_at: null
      };
      await this.db.insert(entry, connection);
    });
    await this.maybePrune(now);
  }

  /** Gives back a reservation whose upload could not be prepared. */
  async release(id: string, profileId: string): Promise<void> {
    try {
      await this.db.delete(id, profileId);
    } catch (error) {
      this.logger.warn(
        `Could not release upload budget reservation ${id}: ${errorMessage(error)}`
      );
    }
  }

  /**
   * Settles an upload at its stored size (0 when nothing was stored); never
   * fails the caller. If this fails the entry stays pending and is read later.
   */
  async recordSize(
    id: string,
    profileId: string,
    sizeBytes: number
  ): Promise<void> {
    try {
      await this.db.recordSize(id, profileId, sizeBytes);
    } catch (error) {
      this.logger.warn(
        `Could not record the size of upload ${id}: ${errorMessage(error)}`
      );
    }
  }

  /** Reads the sizes of a few of the profile's pending entries. */
  private async settlePendingSizes(
    profileId: string,
    since: number,
    now: number
  ): Promise<void> {
    let pending: PendingMediaUploadSize[];
    try {
      pending = await this.db.findPendingSizes({
        profileId,
        sinceMs: since,
        createdBefore: now - PENDING_SIZE_READ_AFTER_MS,
        checkedBefore: now - PENDING_SIZE_RECHECK_AFTER_MS,
        limit: PENDING_SIZES_PER_RESERVATION
      });
    } catch (error) {
      this.logger.warn(
        `Could not list pending upload sizes of ${profileId}: ${errorMessage(error)}`
      );
      return;
    }
    for (const entry of pending) {
      await this.settlePendingSize(profileId, entry, now);
    }
  }

  private async settlePendingSize(
    profileId: string,
    entry: PendingMediaUploadSize,
    now: number
  ): Promise<void> {
    try {
      let read: ObjectSizeRead | null = null;
      try {
        read = await this.readers[entry.source](entry.pending_object_key);
      } catch (error) {
        // Inconclusive (403, throttling, network): the entry keeps counting
        // its reserved bytes and is read again later.
        this.logger.warn(
          `Could not read the size of upload ${entry.id}: ${errorMessage(error)}`
        );
      }
      if (read?.exists) {
        await this.db.recordSize(entry.id, profileId, read.bytes);
      } else if (
        read &&
        entry.created_at < now - PENDING_MISSING_SETTLES_AFTER_MS
      ) {
        await this.db.recordSize(entry.id, profileId, 0);
      } else {
        await this.db.markSizeChecked(entry.id, profileId, now);
      }
    } catch (error) {
      this.logger.warn(
        `Could not settle the size of upload ${entry.id}: ${errorMessage(error)}`
      );
    }
  }

  private async maybePrune(now: number): Promise<void> {
    if (this.random() >= PRUNE_PROBABILITY) return;
    try {
      await this.db.deleteOlderThan(
        now - 2 * MEDIA_UPLOAD_BUDGET_WINDOW_MS,
        PRUNE_BATCH
      );
    } catch (error) {
      this.logger.warn(`Could not prune upload budget: ${errorMessage(error)}`);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatBytes(bytes: number): string {
  return bytes % GIB === 0
    ? `${bytes / GIB} GiB`
    : `${Math.round(bytes / (1024 * 1024))} MiB`;
}

export type MediaUploadBudget = Pick<
  MediaUploadBudgetService,
  'reserve' | 'release' | 'recordSize'
>;

export const mediaUploadBudgetService = new MediaUploadBudgetService();
