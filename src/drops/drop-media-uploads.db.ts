import { DROP_MEDIA_UPLOADS_TABLE, DROP_MEDIA_TABLE } from '@/constants';
import {
  DropMediaUploadEntity,
  DropMediaUploadStatus
} from '@/entities/IDropMediaUpload';
import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '@/sql-executor';
import { RequestContext } from '@/request.context';
import { Time, Timer } from '@/time';

const hasOwn = (
  Object as ObjectConstructor & {
    hasOwn(object: object, propertyKey: PropertyKey): boolean;
  }
).hasOwn;

const PATCHABLE_COLUMNS = [
  'status',
  'error_reason',
  'drop_id',
  'wave_id',
  'updated_at',
  'completed_at'
] as const;

type PatchableColumn = (typeof PATCHABLE_COLUMNS)[number];
type Writable<T> = { -readonly [P in keyof T]: T[P] };
type DropMediaUploadPatch = Partial<
  Writable<Pick<DropMediaUploadEntity, PatchableColumn>>
>;

export class DropMediaUploadsDb extends LazyDbAccessCompatibleService {
  async createUpload(
    upload: DropMediaUploadEntity,
    {
      connection,
      timer
    }: {
      connection?: ConnectionWrapper<any>;
      timer?: Timer;
    } = {}
  ): Promise<void> {
    timer?.start(`${this.constructor.name}->createUpload`);
    try {
      await this.db.execute(
        `insert into ${DROP_MEDIA_UPLOADS_TABLE}
          (id, profile_id, source, public_key, public_url, ingest_bucket, ingest_key,
           s3_upload_id, declared_mime_type, status, error_reason, drop_id, wave_id,
           created_at, updated_at, completed_at)
         values
          (:id, :profile_id, :source, :public_key, :public_url, :ingest_bucket, :ingest_key,
           :s3_upload_id, :declared_mime_type, :status, :error_reason, :drop_id, :wave_id,
           :created_at, :updated_at, :completed_at)`,
        upload,
        connection ? { wrappedConnection: connection } : undefined
      );
    } finally {
      timer?.stop(`${this.constructor.name}->createUpload`);
    }
  }

  async findById(
    id: string,
    connection?: ConnectionWrapper<any>
  ): Promise<DropMediaUploadEntity | null> {
    const rows = await this.db.execute<DropMediaUploadEntity>(
      `select * from ${DROP_MEDIA_UPLOADS_TABLE} where id = :id`,
      { id },
      connection ? { wrappedConnection: connection } : undefined
    );
    return rows[0] ?? null;
  }

  async findByPublicKeyAndS3UploadId({
    publicKey,
    s3UploadId
  }: {
    publicKey: string;
    s3UploadId: string;
  }): Promise<DropMediaUploadEntity | null> {
    const rows = await this.db.execute<DropMediaUploadEntity>(
      `select *
       from ${DROP_MEDIA_UPLOADS_TABLE}
       where public_key = :publicKey
         and s3_upload_id = :s3UploadId
       order by created_at desc
       limit 1`,
      { publicKey, s3UploadId }
    );
    return rows[0] ?? null;
  }

  async findByPublicUrl(
    publicUrl: string
  ): Promise<DropMediaUploadEntity | null> {
    const rows = await this.db.execute<DropMediaUploadEntity>(
      `select *
       from ${DROP_MEDIA_UPLOADS_TABLE}
       where public_url = :publicUrl
       order by created_at desc
       limit 1`,
      { publicUrl }
    );
    return rows[0] ?? null;
  }

  async updateUpload(
    {
      id,
      patch
    }: {
      id: string;
      patch: DropMediaUploadPatch;
    },
    {
      connection,
      timer
    }: {
      connection?: ConnectionWrapper<any>;
      timer?: Timer;
    } = {}
  ): Promise<void> {
    timer?.start(`${this.constructor.name}->updateUpload`);
    try {
      const allowedPatch = this.getAllowedPatch(patch);
      const assignments = Object.keys(allowedPatch)
        .map((key) => `${key} = :${key}`)
        .join(', ');
      if (!assignments) {
        return;
      }
      await this.db.execute(
        `update ${DROP_MEDIA_UPLOADS_TABLE} set ${assignments} where id = :id`,
        { id, ...allowedPatch },
        connection ? { wrappedConnection: connection } : undefined
      );
    } finally {
      timer?.stop(`${this.constructor.name}->updateUpload`);
    }
  }

  async transitionStatus(
    {
      id,
      fromStatuses,
      toStatus,
      updatedBefore,
      patch = {}
    }: {
      id: string;
      fromStatuses: DropMediaUploadStatus[];
      toStatus: DropMediaUploadStatus;
      updatedBefore?: number;
      patch?: Omit<DropMediaUploadPatch, 'status' | 'updated_at'>;
    },
    ctx: RequestContext = {}
  ): Promise<boolean> {
    const allowedPatch = this.getAllowedPatch({
      ...patch,
      status: toStatus,
      updated_at: Time.currentMillis()
    });
    const assignments = Object.keys(allowedPatch)
      .map((key) => `${key} = :${key}`)
      .join(', ');
    const params = {
      id,
      fromStatuses,
      ...allowedPatch,
      ...(updatedBefore === undefined ? {} : { updatedBefore })
    };
    const result = await this.db.execute(
      `update ${DROP_MEDIA_UPLOADS_TABLE}
       set ${assignments}
       where id = :id
         and status in (:fromStatuses)
         ${updatedBefore === undefined ? '' : 'and updated_at < :updatedBefore'}`,
      params,
      ctx.connection ? { wrappedConnection: ctx.connection } : undefined
    );
    return this.db.getAffectedRows(result) === 1;
  }

  async attachUploadsToDrop({
    mediaUploadIds,
    dropId,
    waveId,
    connection,
    timer
  }: {
    mediaUploadIds: string[];
    dropId: string;
    waveId: string;
    connection: ConnectionWrapper<any>;
    timer?: Timer;
  }): Promise<void> {
    const uniqueUploadIds = Array.from(new Set(mediaUploadIds.filter(Boolean)));
    if (!uniqueUploadIds.length) {
      return;
    }
    timer?.start(`${this.constructor.name}->attachUploadsToDrop`);
    try {
      await this.db.execute(
        `update ${DROP_MEDIA_UPLOADS_TABLE}
         set drop_id = :dropId,
             wave_id = :waveId,
             updated_at = :updatedAt
         where id in (:mediaUploadIds)`,
        {
          mediaUploadIds: uniqueUploadIds,
          dropId,
          waveId,
          updatedAt: Time.currentMillis()
        },
        { wrappedConnection: connection }
      );
    } finally {
      timer?.stop(`${this.constructor.name}->attachUploadsToDrop`);
    }
  }

  async findDropIdsByUploadId(uploadId: string): Promise<string[]> {
    const rows = await this.db.execute<{ drop_id: string }>(
      `select distinct drop_id
       from ${DROP_MEDIA_TABLE}
       where media_upload_id = :uploadId
         and drop_id is not null`,
      { uploadId }
    );
    return rows.map((row) => row.drop_id);
  }

  private getAllowedPatch(patch: DropMediaUploadPatch): DropMediaUploadPatch {
    const allowedPatch: DropMediaUploadPatch = {};
    for (const column of PATCHABLE_COLUMNS) {
      if (hasOwn(patch, column)) {
        allowedPatch[column] = patch[column] as never;
      }
    }
    return allowedPatch;
  }
}

export const dropMediaUploadsDb = new DropMediaUploadsDb(dbSupplier);
