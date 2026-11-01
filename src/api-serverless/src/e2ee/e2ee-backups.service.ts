import {
  E2eeServiceDeps,
  enforceE2eeByteBudget,
  enforceE2eeRateLimit,
  requireOwnActiveDevice
} from '@/api/e2ee/e2ee-context';
import { ApiE2eeAck } from '@/api/generated/models/ApiE2eeAck';
import { ApiE2eeBackup } from '@/api/generated/models/ApiE2eeBackup';
import { ApiE2eeBackupChunk } from '@/api/generated/models/ApiE2eeBackupChunk';
import { ApiE2eeBackupChunkData } from '@/api/generated/models/ApiE2eeBackupChunkData';
import { ApiE2eeBackupChunkPage } from '@/api/generated/models/ApiE2eeBackupChunkPage';
import { ApiE2eeBackupChunkUpload } from '@/api/generated/models/ApiE2eeBackupChunkUpload';
import { ApiE2eeBackupStatus } from '@/api/generated/models/ApiE2eeBackupStatus';
import { ApiE2eeCompactBackupRequest } from '@/api/generated/models/ApiE2eeCompactBackupRequest';
import { ApiE2eeCreateBackupRequest } from '@/api/generated/models/ApiE2eeCreateBackupRequest';
import {
  E2eeBackupChunkRow,
  E2eeBackupRepository,
  E2eeBackupRow
} from '@/e2ee/e2ee-backup.db';
import { E2eeCiphertextStore } from '@/e2ee/e2ee-ciphertext-store';
import {
  E2EE_BACKUP_CHUNK_BUCKETS,
  E2EE_BACKUP_LIST_DEFAULT_LIMIT,
  E2EE_BACKUP_MAX_CHUNK_BYTES,
  E2EE_BACKUP_MAX_CHUNKS,
  E2EE_BACKUP_MAX_ENVELOPE_BYTES,
  E2EE_BACKUP_PENDING_TTL_MS,
  E2EE_BACKUP_PRUNE_BATCH,
  E2EE_BACKUP_QUOTA_BYTES,
  E2EE_RATE_LIMITS
} from '@/e2ee/e2ee.constants';
import { decodeE2eeBase64, isE2eeBucketLength } from '@/e2ee/e2ee-encoding';
import { e2eeErrors } from '@/e2ee/e2ee-errors';
import { Logger } from '@/logging';

const logger = Logger.get('E2EE_BACKUPS');

export interface E2eeBackupServiceDeps {
  /** Device ownership, rate limits, clock and randomness. */
  readonly e2ee: E2eeServiceDeps;
  readonly backups: E2eeBackupRepository;
  readonly store: E2eeCiphertextStore;
  /** E2EE_BACKUPS_ENABLED kill switch. */
  readonly backupsEnabled: () => boolean;
  /** Defaults to E2EE_BACKUP_QUOTA_BYTES (tests use small values). */
  readonly quotaBytes?: number;
  /** Defaults to E2EE_BACKUP_MAX_CHUNKS. */
  readonly maxChunks?: number;
}

function toApiBackup(row: E2eeBackupRow): ApiE2eeBackup {
  return {
    backup_id: row.backup_id,
    envelope: Buffer.from(row.envelope).toString('base64'),
    active: !!row.active,
    chunk_count: Number(row.chunk_count),
    size: Number(row.size),
    next_seq: Number(row.next_seq),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    activated_at: row.activated_at === null ? null : Number(row.activated_at)
  };
}

function toApiChunk(row: E2eeBackupChunkRow): ApiE2eeBackupChunk {
  return {
    seq: Number(row.seq),
    size: Number(row.size),
    created_at: Number(row.created_at)
  };
}

/**
 * Encrypted message-history backups (history backup v1). The client encrypts
 * its decrypted history under a random backup key and uploads ciphertext
 * chunks; the server stores them per profile and never sees plaintext, the
 * backup key or the recovery code. It sees chunk counts, padded sizes, times
 * and which device uploaded what.
 */
export class E2eeBackupsService {
  constructor(private readonly deps: E2eeBackupServiceDeps) {}

  private get repo() {
    return this.deps.backups;
  }

  private get quotaBytes(): number {
    return this.deps.quotaBytes ?? E2EE_BACKUP_QUOTA_BYTES;
  }

  private now(): number {
    return this.deps.e2ee.now();
  }

  private requireEnabled(): void {
    if (!this.deps.backupsEnabled()) throw e2eeErrors.backupsDisabled();
  }

  /** The generation, which must belong to the caller (else 404). */
  private async ownBackup(
    callerProfileId: string,
    backupId: string,
    connection?: Parameters<E2eeBackupRepository['getBackup']>[1]
  ): Promise<E2eeBackupRow> {
    const backup = await this.repo.getBackup(backupId, connection);
    if (backup?.profile_id !== callerProfileId) {
      throw e2eeErrors.notFound('Backup');
    }
    return backup;
  }

  /** Object deletes run after the metadata delete committed (best effort). */
  private async deleteObjects(keys: readonly string[]): Promise<void> {
    if (!keys.length) return;
    try {
      await this.deps.store.deleteMany(keys);
    } catch (error) {
      logger.warn(
        `E2EE backup object delete failed (${keys.length} objects): ${
          (error as Error)?.message ?? 'unknown'
        }`
      );
    }
  }

  async getStatus(callerProfileId: string): Promise<ApiE2eeBackupStatus> {
    this.requireEnabled();
    const [backup, usedBytes] = await Promise.all([
      this.repo.getActiveBackup(callerProfileId),
      this.repo.getUsageBytes(callerProfileId)
    ]);
    return {
      backup: backup ? toApiBackup(backup) : null,
      used_bytes: usedBytes,
      quota_bytes: this.quotaBytes,
      max_chunk_bytes: E2EE_BACKUP_MAX_CHUNK_BYTES,
      chunk_buckets: [...E2EE_BACKUP_CHUNK_BUCKETS]
    };
  }

  async getBackup(
    callerProfileId: string,
    backupId: string
  ): Promise<ApiE2eeBackup> {
    this.requireEnabled();
    return toApiBackup(await this.ownBackup(callerProfileId, backupId));
  }

  async createBackup(
    callerProfileId: string,
    request: ApiE2eeCreateBackupRequest
  ): Promise<ApiE2eeBackup> {
    this.requireEnabled();
    const envelope = decodeE2eeBase64(
      request.envelope,
      'envelope',
      E2EE_BACKUP_MAX_ENVELOPE_BYTES
    );
    if (!envelope.length) throw e2eeErrors.badRequest('envelope is empty');
    await requireOwnActiveDevice(
      this.deps.e2ee,
      callerProfileId,
      request.device_key
    );
    await enforceE2eeRateLimit(
      this.deps.e2ee,
      E2EE_RATE_LIMITS.backupGenerationsPerProfile,
      callerProfileId
    );
    await this.pruneStalePending();
    const now = this.now();
    const row: E2eeBackupRow = {
      backup_id: request.backup_id,
      profile_id: callerProfileId,
      envelope,
      active: false,
      next_seq: 1,
      chunk_count: 0,
      size: 0,
      created_by_device_key: request.device_key,
      created_at: now,
      updated_at: now,
      activated_at: null
    };
    const replacedKeys = await this.repo.executeNativeQueriesInTransaction(
      async (connection) => {
        await this.repo.lockProfile(callerProfileId, connection);
        if (await this.repo.getBackup(request.backup_id, connection)) {
          throw e2eeErrors.badRequest('backup_id is already in use');
        }
        // At most one pending generation: a new one replaces an older one.
        const pending = (
          await this.repo.listProfileBackups(callerProfileId, connection)
        )
          .filter((backup) => !backup.active)
          .map((backup) => backup.backup_id);
        const keys = await this.repo.listObjectKeys(pending, connection);
        await this.repo.deleteBackups(pending, connection);
        await this.repo.insertBackup(row, connection);
        return keys;
      }
    );
    await this.deleteObjects(replacedKeys);
    return toApiBackup(row);
  }

  async appendChunk(
    callerProfileId: string,
    backupId: string,
    request: ApiE2eeBackupChunkUpload
  ): Promise<ApiE2eeBackupChunk> {
    this.requireEnabled();
    const data = decodeE2eeBase64(
      request.data,
      'data',
      E2EE_BACKUP_MAX_CHUNK_BYTES
    );
    if (!isE2eeBucketLength(data.length, E2EE_BACKUP_CHUNK_BUCKETS)) {
      throw e2eeErrors.badRequest('data length must be a backup chunk bucket');
    }
    await requireOwnActiveDevice(
      this.deps.e2ee,
      callerProfileId,
      request.device_key
    );
    // Cheap ownership check before any object is written.
    await this.ownBackup(callerProfileId, backupId);
    await enforceE2eeRateLimit(
      this.deps.e2ee,
      E2EE_RATE_LIMITS.backupChunksPerProfile,
      callerProfileId
    );
    await enforceE2eeByteBudget(
      this.deps.e2ee,
      E2EE_RATE_LIMITS.backupBytesPerProfile,
      callerProfileId,
      data.length
    );
    const objectKey = `backup/${backupId}/${this.deps.e2ee
      .randomHex(16)
      .slice(2)}`;
    await this.deps.store.put(objectKey, data);
    try {
      return await this.repo.executeNativeQueriesInTransaction(
        async (connection) => {
          await this.repo.lockProfile(callerProfileId, connection);
          const backup = await this.ownBackup(
            callerProfileId,
            backupId,
            connection
          );
          if (
            Number(backup.chunk_count) >=
            (this.deps.maxChunks ?? E2EE_BACKUP_MAX_CHUNKS)
          ) {
            throw e2eeErrors.tooLarge('Backup chunk count');
          }
          const used = await this.repo.getUsageBytes(
            callerProfileId,
            connection
          );
          if (used + data.length > this.quotaBytes) {
            throw e2eeErrors.backupQuota(this.quotaBytes);
          }
          const chunk: E2eeBackupChunkRow = {
            backup_id: backupId,
            seq: Number(backup.next_seq),
            profile_id: callerProfileId,
            size: data.length,
            object_key: objectKey,
            uploader_device_key: request.device_key,
            created_at: this.now()
          };
          await this.repo.insertChunk(chunk, connection);
          await this.repo.recordChunk(
            {
              backupId,
              seq: chunk.seq,
              size: chunk.size,
              updatedAt: chunk.created_at
            },
            connection
          );
          return toApiChunk(chunk);
        }
      );
    } catch (error) {
      await this.deleteObjects([objectKey]);
      throw error;
    }
  }

  async listChunks(
    callerProfileId: string,
    backupId: string,
    query: { readonly after_seq?: number; readonly limit?: number }
  ): Promise<ApiE2eeBackupChunkPage> {
    this.requireEnabled();
    await this.ownBackup(callerProfileId, backupId);
    const limit = query.limit ?? E2EE_BACKUP_LIST_DEFAULT_LIMIT;
    const rows = await this.repo.listChunks(
      backupId,
      query.after_seq ?? 0,
      limit + 1
    );
    const items = rows.slice(0, limit).map(toApiChunk);
    return {
      items,
      next_after_seq:
        rows.length > limit ? (items[items.length - 1]?.seq ?? null) : null
    };
  }

  async getChunk(
    callerProfileId: string,
    backupId: string,
    seq: number
  ): Promise<ApiE2eeBackupChunkData> {
    this.requireEnabled();
    await this.ownBackup(callerProfileId, backupId);
    const chunk = await this.repo.getChunk(backupId, seq);
    if (!chunk) throw e2eeErrors.notFound('Backup chunk');
    const data = await this.deps.store.get(chunk.object_key);
    if (!data) throw e2eeErrors.notFound('Backup chunk');
    return { seq: Number(chunk.seq), data: data.toString('base64') };
  }

  async activate(
    callerProfileId: string,
    backupId: string,
    deviceKey: string
  ): Promise<ApiE2eeBackup> {
    this.requireEnabled();
    await requireOwnActiveDevice(this.deps.e2ee, callerProfileId, deviceKey);
    const { backup, keys } = await this.repo.executeNativeQueriesInTransaction(
      async (connection) => {
        await this.repo.lockProfile(callerProfileId, connection);
        const target = await this.ownBackup(
          callerProfileId,
          backupId,
          connection
        );
        const others = (
          await this.repo.listProfileBackups(callerProfileId, connection)
        )
          .map((row) => row.backup_id)
          .filter((id) => id !== backupId);
        const objectKeys = await this.repo.listObjectKeys(others, connection);
        await this.repo.deleteBackups(others, connection);
        if (target.active) return { backup: target, keys: objectKeys };
        const activatedAt = this.now();
        await this.repo.activateBackup(backupId, activatedAt, connection);
        return {
          backup: {
            ...target,
            active: true,
            activated_at: activatedAt,
            updated_at: activatedAt
          },
          keys: objectKeys
        };
      }
    );
    await this.deleteObjects(keys);
    return toApiBackup(backup);
  }

  async compact(
    callerProfileId: string,
    backupId: string,
    request: ApiE2eeCompactBackupRequest
  ): Promise<ApiE2eeBackup> {
    this.requireEnabled();
    await requireOwnActiveDevice(
      this.deps.e2ee,
      callerProfileId,
      request.device_key
    );
    const { backup, keys } = await this.repo.executeNativeQueriesInTransaction(
      async (connection) => {
        await this.repo.lockProfile(callerProfileId, connection);
        const target = await this.ownBackup(
          callerProfileId,
          backupId,
          connection
        );
        if (request.through_seq >= Number(target.next_seq)) {
          throw e2eeErrors.badRequest('through_seq is beyond the last chunk');
        }
        const objectKeys = await this.repo.listObjectKeys(
          [backupId],
          connection,
          request.through_seq
        );
        await this.repo.deleteChunksThrough(
          backupId,
          request.through_seq,
          this.now(),
          connection
        );
        const updated = await this.repo.getBackup(backupId, connection);
        return { backup: updated ?? target, keys: objectKeys };
      }
    );
    await this.deleteObjects(keys);
    return toApiBackup(backup);
  }

  async deleteAll(callerProfileId: string): Promise<ApiE2eeAck> {
    this.requireEnabled();
    const keys = await this.repo.executeNativeQueriesInTransaction(
      async (connection) => {
        await this.repo.lockProfile(callerProfileId, connection);
        const ids = (
          await this.repo.listProfileBackups(callerProfileId, connection)
        ).map((row) => row.backup_id);
        const objectKeys = await this.repo.listObjectKeys(ids, connection);
        await this.repo.deleteBackups(ids, connection);
        return objectKeys;
      }
    );
    await this.deleteObjects(keys);
    return {};
  }

  /** Abandoned pending generations (never activated) older than a day. */
  private async pruneStalePending(): Promise<void> {
    try {
      const stale = await this.repo.listStalePending(
        this.now() - E2EE_BACKUP_PENDING_TTL_MS,
        E2EE_BACKUP_PRUNE_BATCH
      );
      for (const row of stale) {
        const keys = await this.repo.executeNativeQueriesInTransaction(
          async (connection) => {
            // Re-check under the profile lock: it may have been activated.
            await this.repo.lockProfile(row.profile_id, connection);
            const current = await this.repo.getBackup(
              row.backup_id,
              connection
            );
            if (!current || current.active) return [];
            const objectKeys = await this.repo.listObjectKeys(
              [row.backup_id],
              connection
            );
            await this.repo.deleteBackups([row.backup_id], connection);
            return objectKeys;
          }
        );
        await this.deleteObjects(keys);
      }
    } catch (error) {
      logger.warn(
        `E2EE backup pruning failed: ${(error as Error)?.message ?? 'unknown'}`
      );
    }
  }
}
