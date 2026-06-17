import { PROFILE_CMS_POINTER_EVENTS_TABLE } from '@/constants';
import {
  ProfileCmsPointerEventEntity,
  ProfileCmsPointerEventType
} from '@/entities/IProfileCmsPointerEvent';
import { RequestContext } from '@/request.context';
import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '@/sql-executor';

export type NewProfileCmsPointerEventEntity = ProfileCmsPointerEventEntity;

export class ProfileCmsPointerEventsDb extends LazyDbAccessCompatibleService {
  async insert(
    entity: NewProfileCmsPointerEventEntity,
    ctx: RequestContext
  ): Promise<void> {
    await this.timedExecute(
      'insert',
      `insert into ${PROFILE_CMS_POINTER_EVENTS_TABLE} (
        id,
        event_type,
        profile_id,
        profile_handle,
        package_db_id,
        package_id,
        package_version,
        package_hash,
        payload_hash,
        previous_package_db_id,
        actor_profile_id,
        signer_address,
        signature,
        typed_data,
        typed_data_hash,
        storage_receipt,
        created_at
      ) values (
        :id,
        :event_type,
        :profile_id,
        :profile_handle,
        :package_db_id,
        :package_id,
        :package_version,
        :package_hash,
        :payload_hash,
        :previous_package_db_id,
        :actor_profile_id,
        :signer_address,
        :signature,
        :typed_data,
        :typed_data_hash,
        :storage_receipt,
        :created_at
      )`,
      this.toParams(entity),
      ctx
    );
  }

  async listByPackageId(
    packageDbId: string,
    ctx: RequestContext
  ): Promise<ProfileCmsPointerEventEntity[]> {
    return this.hydrateMany(
      await this.timedExecute<ProfileCmsPointerEventEntity>(
        'listByPackageId',
        `select * from ${PROFILE_CMS_POINTER_EVENTS_TABLE}
         where package_db_id = :packageDbId
         order by created_at asc, id asc`,
        { packageDbId },
        ctx
      )
    );
  }

  async listByProfileId(
    profileId: string,
    ctx: RequestContext
  ): Promise<ProfileCmsPointerEventEntity[]> {
    return this.hydrateMany(
      await this.timedExecute<ProfileCmsPointerEventEntity>(
        'listByProfileId',
        `select * from ${PROFILE_CMS_POINTER_EVENTS_TABLE}
         where profile_id = :profileId
         order by created_at asc, id asc`,
        { profileId },
        ctx
      )
    );
  }

  private hydrateMany(
    rows: ProfileCmsPointerEventEntity[]
  ): ProfileCmsPointerEventEntity[] {
    return rows.map((row) => ({
      ...row,
      event_type: row.event_type as ProfileCmsPointerEventType,
      typed_data: parseJsonColumn(row.typed_data),
      storage_receipt: parseJsonColumn(row.storage_receipt)
    }));
  }

  private toParams(
    entity: NewProfileCmsPointerEventEntity
  ): Record<string, unknown> {
    return {
      ...entity,
      typed_data:
        entity.typed_data === null || entity.typed_data === undefined
          ? null
          : JSON.stringify(entity.typed_data),
      storage_receipt:
        entity.storage_receipt === null || entity.storage_receipt === undefined
          ? null
          : JSON.stringify(entity.storage_receipt)
    };
  }

  private async timedExecute<T = unknown>(
    timerName: string,
    sql: string,
    params: Record<string, unknown>,
    ctx: RequestContext
  ): Promise<T[]> {
    ctx.timer?.start(`${this.constructor.name}->${timerName}`);
    try {
      return await this.db.execute<T>(
        sql,
        params,
        this.options(ctx.connection)
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->${timerName}`);
    }
  }

  private options(
    connection: ConnectionWrapper<unknown> | undefined
  ): { wrappedConnection: ConnectionWrapper<unknown> } | undefined {
    return connection ? { wrappedConnection: connection } : undefined;
  }
}

function parseJsonColumn(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export const profileCmsPointerEventsDb = new ProfileCmsPointerEventsDb(
  dbSupplier
);
