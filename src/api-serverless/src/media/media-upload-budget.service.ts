import { CustomApiCompliantException } from '@/exceptions';
import {
  MediaUploadBudgetSource,
  MediaUploadBudgetEntryEntity
} from '@/entities/IMediaUploadBudget';
import {
  MediaUploadBudgetDb,
  mediaUploadBudgetDb
} from '@/media/media-upload-budget.db';
import { Logger } from '@/logging';
import { Time } from '@/time';

const GIB = 1024 * 1024 * 1024;
export const MEDIA_UPLOAD_BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000;
/** A single-PUT URL is valid for 15 minutes; its size is read after that. */
const SINGLE_PUT_SETTLED_AFTER_MS = 30 * 60 * 1000;
const PENDING_SIZES_PER_RESERVATION = 5;
const PRUNE_BATCH = 1000;
const PRUNE_PROBABILITY = 0.01;

export interface MediaUploadBudgetLimits {
  /** Uploads a profile may prepare per rolling 24 hours. */
  readonly uploadsPerDay: number;
  /** Stored bytes after which a profile may prepare no more uploads that day. */
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

export const MEDIA_UPLOAD_BUDGET_EXCEEDED = 'MEDIA_UPLOAD_BUDGET_EXCEEDED';

/** Reads an object's stored size; null when it does not exist. */
export type ObjectSizeReader = (key: string) => Promise<number | null>;

/**
 * A per-profile rolling budget for public drop/wave media and attachment
 * uploads, modelled on the E2EE blob quota: every prepared upload is a row,
 * reservations for one profile are serialized by locking its profile row,
 * and usage is summed over the last 24 hours. The upload count is checked
 * when an upload is prepared. Sizes are recorded when known (multipart
 * completion, or later for single-PUT uploads, which have no completion
 * call); preparation is refused once the stored bytes reach the budget.
 */
export class MediaUploadBudgetService {
  private readonly logger = Logger.get(this.constructor.name);

  constructor(
    private readonly db: MediaUploadBudgetDb = mediaUploadBudgetDb,
    private readonly limits: () => MediaUploadBudgetLimits = () =>
      mediaUploadBudgetLimitsFrom(process.env),
    private readonly random: () => number = Math.random
  ) {}

  /**
   * Counts one prepared upload against the profile's budget, or refuses it
   * with 429 MEDIA_UPLOAD_BUDGET_EXCEEDED. `pendingObjectKey` marks a
   * single-PUT upload whose size is read later from that key.
   */
  async reserve({
    id,
    profileId,
    source,
    pendingObjectKey = null,
    readObjectSize
  }: {
    id: string;
    profileId: string;
    source: MediaUploadBudgetSource;
    pendingObjectKey?: string | null;
    readObjectSize?: ObjectSizeReader;
  }): Promise<void> {
    const now = Time.currentMillis();
    const since = now - MEDIA_UPLOAD_BUDGET_WINDOW_MS;
    if (readObjectSize) {
      await this.settlePendingSizes(profileId, since, now, readObjectSize);
    }
    const limits = this.limits();
    await this.db.executeNativeQueriesInTransaction(async (connection) => {
      await this.db.lockProfile(profileId, connection);
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
      if (usage.bytes >= limits.bytesPerDay) {
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
        pending_object_key: pendingObjectKey
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

  /** Records a completed upload's stored size; never fails the upload. */
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

  /** Reads the size of the profile's settled single-PUT uploads (bounded). */
  private async settlePendingSizes(
    profileId: string,
    since: number,
    now: number,
    readObjectSize: ObjectSizeReader
  ): Promise<void> {
    try {
      const pending = await this.db.findPendingSizes(
        profileId,
        since,
        now - SINGLE_PUT_SETTLED_AFTER_MS,
        PENDING_SIZES_PER_RESERVATION
      );
      for (const upload of pending) {
        const size = await readObjectSize(upload.pending_object_key);
        await this.db.recordSize(upload.id, profileId, size ?? 0);
      }
    } catch (error) {
      // Sizes are settled again on the next reservation.
      this.logger.warn(
        `Could not settle pending upload sizes of ${profileId}: ${errorMessage(error)}`
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
