import { ATTACHMENTS_TABLE, DROP_ATTACHMENTS_TABLE } from '@/constants';
import {
  AttachmentEntity,
  AttachmentStatus,
  DropAttachmentEntity
} from '@/entities/IAttachment';
import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '@/sql-executor';
import { RequestContext } from '@/request.context';
import { Timer } from '@/time';

export class AttachmentsDb extends LazyDbAccessCompatibleService {
  async createAttachment(
    attachment: AttachmentEntity,
    {
      connection,
      timer
    }: {
      connection?: ConnectionWrapper<any>;
      timer?: Timer;
    } = {}
  ) {
    timer?.start(`${this.constructor.name}->createAttachment`);
    try {
      await this.db.execute(
        `insert into ${ATTACHMENTS_TABLE}
          (id, owner_profile_id, original_file_name, kind, declared_mime, detected_mime, status,
           original_bucket, original_key, size_bytes, sha256, guardduty_status, verdict,
           ipfs_cid, ipfs_url, error_reason, created_at, updated_at)
         values
          (:id, :owner_profile_id, :original_file_name, :kind, :declared_mime, :detected_mime, :status,
           :original_bucket, :original_key, :size_bytes, :sha256, :guardduty_status, :verdict,
           :ipfs_cid, :ipfs_url, :error_reason, :created_at, :updated_at)`,
        attachment,
        connection ? { wrappedConnection: connection } : undefined
      );
    } finally {
      timer?.stop(`${this.constructor.name}->createAttachment`);
    }
  }

  async updateAttachment(
    {
      id,
      patch
    }: {
      id: string;
      patch: Partial<
        Pick<
          AttachmentEntity,
          | 'detected_mime'
          | 'status'
          | 'original_bucket'
          | 'original_key'
          | 'size_bytes'
          | 'sha256'
          | 'guardduty_status'
          | 'verdict'
          | 'ipfs_cid'
          | 'ipfs_url'
          | 'error_reason'
          | 'updated_at'
        >
      >;
    },
    {
      connection,
      timer
    }: {
      connection?: ConnectionWrapper<any>;
      timer?: Timer;
    } = {}
  ) {
    timer?.start(`${this.constructor.name}->updateAttachment`);
    try {
      const assignments = Object.keys(patch)
        .map((key) => `${key} = :${key}`)
        .join(', ');
      if (!assignments) {
        return;
      }
      await this.db.execute(
        `update ${ATTACHMENTS_TABLE} set ${assignments} where id = :id`,
        { id, ...patch },
        connection ? { wrappedConnection: connection } : undefined
      );
    } finally {
      timer?.stop(`${this.constructor.name}->updateAttachment`);
    }
  }

  async transitionAttachmentStatus(
    {
      id,
      fromStatus,
      toStatus,
      updatedAt
    }: {
      id: string;
      fromStatus: AttachmentStatus;
      toStatus: AttachmentStatus;
      updatedAt: number;
    },
    {
      connection,
      timer
    }: {
      connection?: ConnectionWrapper<any>;
      timer?: Timer;
    } = {}
  ): Promise<boolean> {
    timer?.start(`${this.constructor.name}->transitionAttachmentStatus`);
    try {
      const result = await this.db.execute(
        `update ${ATTACHMENTS_TABLE}
         set status = :toStatus, updated_at = :updatedAt
         where id = :id and status = :fromStatus`,
        { id, fromStatus, toStatus, updatedAt },
        connection ? { wrappedConnection: connection } : undefined
      );
      return this.db.getAffectedRows(result) === 1;
    } finally {
      timer?.stop(`${this.constructor.name}->transitionAttachmentStatus`);
    }
  }

  async findAttachmentById(
    id: string,
    connection?: ConnectionWrapper<any>
  ): Promise<AttachmentEntity | null> {
    const rows = await this.db.execute<AttachmentEntity>(
      `select * from ${ATTACHMENTS_TABLE} where id = :id`,
      { id },
      connection ? { wrappedConnection: connection } : undefined
    );
    return rows[0] ?? null;
  }

  async findAttachmentByOriginalLocation(
    {
      originalBucket,
      originalKey
    }: {
      originalBucket: string;
      originalKey: string;
    },
    connection?: ConnectionWrapper<any>
  ): Promise<AttachmentEntity | null> {
    const rows = await this.db.execute<AttachmentEntity>(
      `select * from ${ATTACHMENTS_TABLE}
       where original_bucket = :originalBucket
         and original_key = :originalKey
       order by created_at desc
       limit 1`,
      { originalBucket, originalKey },
      connection ? { wrappedConnection: connection } : undefined
    );
    return rows[0] ?? null;
  }

  async findAttachmentsByIds(
    ids: string[],
    connection?: ConnectionWrapper<any>
  ): Promise<Record<string, AttachmentEntity>> {
    if (!ids.length) {
      return {};
    }
    const rows = await this.db.execute<AttachmentEntity>(
      `select * from ${ATTACHMENTS_TABLE} where id in (:ids)`,
      { ids },
      connection ? { wrappedConnection: connection } : undefined
    );
    return rows.reduce(
      (acc, row) => {
        acc[row.id] = row;
        return acc;
      },
      {} as Record<string, AttachmentEntity>
    );
  }

  async findByOwnerAndStatuses({
    ownerProfileId,
    statuses
  }: {
    ownerProfileId: string;
    statuses: AttachmentStatus[];
  }): Promise<AttachmentEntity[]> {
    return this.db.execute<AttachmentEntity>(
      `select * from ${ATTACHMENTS_TABLE}
       where owner_profile_id = :ownerProfileId
         and status in (:statuses)
       order by created_at desc`,
      { ownerProfileId, statuses }
    );
  }

  async insertDropAttachments(
    attachments: DropAttachmentEntity[],
    connection: ConnectionWrapper<any>,
    timer?: Timer
  ) {
    timer?.start(`${this.constructor.name}->insertDropAttachments`);
    try {
      if (!attachments.length) {
        return;
      }
      await Promise.all(
        attachments.map((attachment) =>
          this.db.execute(
            `insert into ${DROP_ATTACHMENTS_TABLE}
              (drop_id, drop_part_id, attachment_id, wave_id)
             values
              (:drop_id, :drop_part_id, :attachment_id, :wave_id)`,
            attachment,
            { wrappedConnection: connection }
          )
        )
      );
    } finally {
      timer?.stop(`${this.constructor.name}->insertDropAttachments`);
    }
  }

  async deleteDropAttachments(dropId: string, ctx: RequestContext) {
    ctx.timer?.start(`${this.constructor.name}->deleteDropAttachments`);
    try {
      await this.db.execute(
        `delete from ${DROP_ATTACHMENTS_TABLE} where drop_id = :dropId`,
        { dropId },
        ctx.connection ? { wrappedConnection: ctx.connection } : undefined
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->deleteDropAttachments`);
    }
  }

  async findAttachmentWaveIds(
    attachmentId: string,
    connection?: ConnectionWrapper<any>
  ): Promise<string[]> {
    const rows = await this.db.execute<{ wave_id: string | null }>(
      `select distinct wave_id from ${DROP_ATTACHMENTS_TABLE}
       where attachment_id = :attachmentId and wave_id is not null`,
      { attachmentId },
      connection ? { wrappedConnection: connection } : undefined
    );
    return rows
      .map((row) => row.wave_id)
      .filter((waveId): waveId is string => !!waveId);
  }

  async getDropAttachments(
    dropIds: string[],
    connection?: ConnectionWrapper<any>
  ): Promise<Record<string, DropAttachmentEntity[]>> {
    if (!dropIds.length) {
      return {};
    }
    const rows = await this.db.execute<DropAttachmentEntity>(
      `select * from ${DROP_ATTACHMENTS_TABLE} where drop_id in (:dropIds)`,
      { dropIds },
      connection ? { wrappedConnection: connection } : undefined
    );
    return dropIds.reduce(
      (acc, dropId) => {
        acc[dropId] = rows.filter((row) => row.drop_id === dropId);
        return acc;
      },
      {} as Record<string, DropAttachmentEntity[]>
    );
  }

  async assertOwnedByProfile({
    attachmentIds,
    ownerProfileId,
    connection
  }: {
    attachmentIds: string[];
    ownerProfileId: string;
    connection?: ConnectionWrapper<any>;
  }): Promise<void> {
    const uniqueAttachmentIds = Array.from(new Set(attachmentIds));
    if (!uniqueAttachmentIds.length) {
      return;
    }
    const rows = await this.db.execute<{ id: string }>(
      `select id from ${ATTACHMENTS_TABLE}
       where id in (:attachmentIds)
         and owner_profile_id = :ownerProfileId`,
      { attachmentIds: uniqueAttachmentIds, ownerProfileId },
      connection ? { wrappedConnection: connection } : undefined
    );
    if (rows.length !== uniqueAttachmentIds.length) {
      throw new Error(`One or more attachments do not belong to the uploader`);
    }
  }
}

export const attachmentsDb = new AttachmentsDb(dbSupplier);
