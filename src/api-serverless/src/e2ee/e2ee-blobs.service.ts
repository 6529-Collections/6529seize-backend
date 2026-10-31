import {
  E2eeServiceDeps,
  enforceE2eeRateLimit,
  isActiveDevice,
  nowSeconds,
  pruneE2eeBlobs,
  requireOwnActiveDevice
} from '@/api/e2ee/e2ee-context';
import { toApiE2eeBlob } from '@/api/e2ee/e2ee.mappers';
import { ApiE2eeBlob } from '@/api/generated/models/ApiE2eeBlob';
import { ApiE2eeBlobChunk } from '@/api/generated/models/ApiE2eeBlobChunk';
import { ApiE2eeCreateBlobRequest } from '@/api/generated/models/ApiE2eeCreateBlobRequest';
import { ApiE2eeReport } from '@/api/generated/models/ApiE2eeReport';
import { ApiE2eeReportRequest } from '@/api/generated/models/ApiE2eeReportRequest';
import {
  E2EE_BLOB_QUOTA,
  E2EE_MAX_BLOB_BYTES,
  E2EE_MAX_BLOB_CHUNK_BYTES,
  E2EE_MAX_BLOB_CHUNKS,
  E2EE_MAX_REPORT_BODY_BYTES,
  E2EE_RATE_LIMITS
} from '@/e2ee/e2ee.constants';
import { E2eeBlobRow } from '@/e2ee/e2ee.db';
import { E2eeBlobStore } from '@/e2ee/e2ee-blob-store';
import { e2eeMessageDigest, verifyE2eeEd25519 } from '@/e2ee/e2ee-digests';
import { decodeE2eeBase64 } from '@/e2ee/e2ee-encoding';
import { E2eeApiException, e2eeErrors } from '@/e2ee/e2ee-errors';
import { Logger } from '@/logging';
import { ConnectionWrapper } from '@/sql-executor';

const logger = Logger.get('E2EE_BLOBS');

export class E2eeBlobsService {
  constructor(private readonly deps: E2eeServiceDeps) {}

  private get db() {
    return this.deps.db;
  }

  /** While attachments are off, no blob row or chunk is read or written. */
  private requireAttachments(): void {
    if (!this.deps.attachmentsEnabled()) {
      throw e2eeErrors.attachmentsDisabled();
    }
  }

  async createBlob(
    callerProfileId: string,
    request: ApiE2eeCreateBlobRequest
  ): Promise<ApiE2eeBlob> {
    this.requireAttachments();
    if (request.chunk_count > E2EE_MAX_BLOB_CHUNKS) {
      throw e2eeErrors.tooLarge('Attachment');
    }
    if (request.size > E2EE_MAX_BLOB_BYTES) {
      throw e2eeErrors.tooLarge('Attachment');
    }
    if (
      request.size < request.chunk_count ||
      request.size > request.chunk_count * E2EE_MAX_BLOB_CHUNK_BYTES
    ) {
      throw e2eeErrors.badRequest('size does not fit chunk_count');
    }
    await requireOwnActiveDevice(
      this.deps,
      callerProfileId,
      request.uploader_device_key
    );
    const roster = await this.db.getCurrentRoster(request.group);
    if (!roster.some((row) => row.device_key === request.uploader_device_key)) {
      throw e2eeErrors.notMember();
    }
    // Misconfigured storage refuses here, before the upload counts.
    const store = this.deps.blobStores.forNewBlob();
    await enforceE2eeRateLimit(
      this.deps,
      E2EE_RATE_LIMITS.blobUploadsPerProfile,
      callerProfileId
    );
    const blob: E2eeBlobRow = {
      blob_id: this.deps.randomHex(16),
      group_handle: request.group,
      uploader_device_key: request.uploader_device_key,
      uploader_profile_id: callerProfileId,
      size: request.size,
      chunk_count: request.chunk_count,
      complete: false,
      created_at: this.deps.now(),
      completed_at: null,
      storage: store.storage
    };
    await pruneE2eeBlobs(this.deps);
    await this.db.executeNativeQueriesInTransaction(async (connection) => {
      // Serializes a profile's uploads so the quota cannot be raced.
      await this.db.lockProfile(callerProfileId, connection);
      const usage = await this.db.getBlobUsage(
        callerProfileId,
        blob.created_at - E2EE_BLOB_QUOTA.rollingWindowMs,
        connection
      );
      if (usage.liveBytes + blob.size > E2EE_BLOB_QUOTA.liveBytes) {
        throw e2eeErrors.tooLarge('Stored encrypted attachments');
      }
      if (usage.recentBytes + blob.size > E2EE_BLOB_QUOTA.rollingBytes) {
        throw e2eeErrors.rateLimited();
      }
      await this.db.insertBlob(blob, connection);
    });
    return toApiE2eeBlob(blob);
  }

  /** Uploader only: the uploading profile with its device still active. */
  private async lockUploaderBlob(
    callerProfileId: string,
    blobId: string,
    connection: ConnectionWrapper<unknown>
  ): Promise<E2eeBlobRow> {
    const blob = await this.db.lockBlob(blobId, connection);
    if (!blob) throw e2eeErrors.notFound('Attachment');
    if (blob.uploader_profile_id !== callerProfileId) {
      throw e2eeErrors.forbidden('Only the uploader can change an attachment');
    }
    const device = await this.db.getDevice(
      blob.uploader_device_key,
      connection
    );
    if (!device || !isActiveDevice(device, nowSeconds(this.deps))) {
      throw e2eeErrors.notYourDevice();
    }
    return blob;
  }

  async putChunk(
    callerProfileId: string,
    blobId: string,
    index: number,
    request: ApiE2eeBlobChunk
  ): Promise<ApiE2eeBlob> {
    this.requireAttachments();
    const data = decodeE2eeBase64(
      request.data,
      'data',
      E2EE_MAX_BLOB_CHUNK_BYTES
    );
    if (!data.length) throw e2eeErrors.badRequest('data is empty');
    const blob = await this.db.executeNativeQueriesInTransaction(
      async (connection) => {
        const locked = await this.lockUploaderBlob(
          callerProfileId,
          blobId,
          connection
        );
        if (locked.complete) {
          throw e2eeErrors.badRequest('The attachment is already complete');
        }
        if (index >= Number(locked.chunk_count)) {
          throw e2eeErrors.badRequest('index is beyond chunk_count');
        }
        const others = (await this.db.getBlobChunkSizes(blobId, connection))
          .filter((chunk) => Number(chunk.chunk_index) !== index)
          .reduce((sum, chunk) => sum + Number(chunk.size), 0);
        if (others + data.length > Number(locked.size)) {
          throw e2eeErrors.tooLarge('Chunks beyond the declared size');
        }
        await this.storeCall(locked, (store) =>
          store.putChunk(
            { blobId, index, data, createdAt: this.deps.now() },
            connection
          )
        );
        return locked;
      }
    );
    return toApiE2eeBlob(blob);
  }

  async completeBlob(
    callerProfileId: string,
    blobId: string
  ): Promise<ApiE2eeBlob> {
    this.requireAttachments();
    const blob = await this.db.executeNativeQueriesInTransaction(
      async (connection) => {
        const locked = await this.lockUploaderBlob(
          callerProfileId,
          blobId,
          connection
        );
        if (locked.complete) return locked;
        const chunks = await this.db.getBlobChunkSizes(blobId, connection);
        const count = Number(locked.chunk_count);
        const indexes = new Set(
          chunks.map((chunk) => Number(chunk.chunk_index))
        );
        const total = chunks.reduce(
          (sum, chunk) => sum + Number(chunk.size),
          0
        );
        if (indexes.size !== count || total !== Number(locked.size)) {
          throw e2eeErrors.badRequest(
            'All chunks must be uploaded and add up to size'
          );
        }
        const completedAt = this.deps.now();
        await this.db.markBlobComplete(blobId, completedAt, connection);
        return { ...locked, complete: true, completed_at: completedAt };
      }
    );
    return toApiE2eeBlob(blob);
  }

  async getChunk(
    callerProfileId: string,
    blobId: string,
    index: number,
    deviceKey: string
  ): Promise<ApiE2eeBlobChunk> {
    this.requireAttachments();
    await requireOwnActiveDevice(this.deps, callerProfileId, deviceKey);
    const blob = await this.db.getBlob(blobId);
    if (!blob?.complete) throw e2eeErrors.notFound('Attachment');
    if (!(await this.db.hasRosterHistory(blob.group_handle, deviceKey))) {
      throw e2eeErrors.notMember();
    }
    if (index >= Number(blob.chunk_count)) {
      throw e2eeErrors.notFound('Attachment chunk');
    }
    let data = await this.storeCall(blob, (store) =>
      store.getChunk(blobId, index)
    );
    if (data === null && blob.storage === 'mysql') {
      // The S3 migration may have moved the blob between the two reads.
      const current = await this.db.getBlob(blobId);
      if (current?.complete && current.storage !== blob.storage) {
        data = await this.storeCall(current, (store) =>
          store.getChunk(blobId, index)
        );
      }
    }
    if (data === null) {
      if (blob.storage !== 'mysql') {
        logger.warn(
          `[E2EE BLOB CHUNK MISSING] [STORAGE ${blob.storage}] [BLOB ${blobId}] [INDEX ${index}]`
        );
      }
      throw e2eeErrors.notFound('Attachment chunk');
    }
    return { data: data.toString('base64') };
  }

  /**
   * Runs a store operation for the blob's storage. External store failures
   * (S3 unreachable, access denied) become 503 E2EE_STORAGE_UNAVAILABLE and
   * are logged without any chunk bytes; MySQL errors propagate unchanged.
   */
  private async storeCall<T>(
    blob: Pick<E2eeBlobRow, 'blob_id' | 'storage'>,
    operation: (store: E2eeBlobStore) => Promise<T>
  ): Promise<T> {
    const store = this.deps.blobStores.forBlob(blob);
    try {
      return await operation(store);
    } catch (error) {
      if (error instanceof E2eeApiException || store.storage === 'mysql') {
        throw error;
      }
      logger.error(
        `[E2EE BLOB STORAGE ERROR] [STORAGE ${store.storage}] [BLOB ${blob.blob_id}] ${
          (error as Error)?.name ?? 'Error'
        }: ${(error as Error)?.message ?? 'unknown'}`
      );
      throw e2eeErrors.storageUnavailable();
    }
  }

  async report(
    callerProfileId: string,
    request: ApiE2eeReportRequest
  ): Promise<ApiE2eeReport> {
    const body = decodeE2eeBase64(
      request.body,
      'body',
      E2EE_MAX_REPORT_BODY_BYTES
    );
    await requireOwnActiveDevice(
      this.deps,
      callerProfileId,
      request.reporter_device_key
    );
    if (
      !(await this.db.hasRosterHistory(
        request.group,
        request.reporter_device_key
      ))
    ) {
      throw e2eeErrors.notMember();
    }
    await enforceE2eeRateLimit(
      this.deps,
      E2EE_RATE_LIMITS.reportsPerProfile,
      callerProfileId
    );
    const sender = await this.db.getDevice(request.sender_device_key);
    const signatureValid = verifyE2eeEd25519(
      request.sender_device_key,
      e2eeMessageDigest({ group: request.group, epoch: request.epoch, body }),
      request.signature
    );
    const senderInGroup = sender
      ? await this.db.hasRosterHistory(request.group, sender.device_key)
      : false;
    const report = {
      id: this.deps.randomHex(16),
      group_handle: request.group,
      epoch: request.epoch,
      body,
      signature: request.signature,
      sender_device_key: request.sender_device_key,
      sender_profile_id: sender?.profile_id ?? null,
      reporter_device_key: request.reporter_device_key,
      reporter_profile_id: callerProfileId,
      reason: String(request.reason),
      notes: request.notes?.trim() || null,
      verified: signatureValid && senderInGroup,
      created_at: this.deps.now(),
      on_hold: false
    };
    await this.db.insertReport(report);
    return {
      id: report.id,
      verified: report.verified,
      sender_profile_id: report.sender_profile_id,
      created_at: report.created_at
    };
  }
}
