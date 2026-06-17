import { PROFILE_CMS_PACKAGES_TABLE } from '@/constants';
import {
  ProfileCmsPackageEntity,
  ProfileCmsPackageStatus
} from '@/entities/IProfileCmsPackage';
import { RequestContext } from '@/request.context';
import {
  ConnectionWrapper,
  dbSupplier,
  LazyDbAccessCompatibleService
} from '@/sql-executor';

export type NewProfileCmsPackageEntity = Omit<
  ProfileCmsPackageEntity,
  'validated_at' | 'published_at' | 'failed_at' | 'archived_at'
> & {
  readonly validated_at?: number | null;
  readonly published_at?: number | null;
  readonly failed_at?: number | null;
  readonly archived_at?: number | null;
};

export class ProfileCmsPackagesDb extends LazyDbAccessCompatibleService {
  async getNextVersion(
    profileId: string,
    packageId: string,
    ctx: RequestContext
  ): Promise<number> {
    const row = await this.timedOneOrNull<{ max_version: number | null }>(
      'getNextVersion',
      `select max(version) as max_version
       from ${PROFILE_CMS_PACKAGES_TABLE}
       where profile_id = :profileId and package_id = :packageId`,
      { profileId, packageId },
      ctx
    );
    return (row?.max_version ?? 0) + 1;
  }

  async insert(
    entity: NewProfileCmsPackageEntity,
    ctx: RequestContext
  ): Promise<ProfileCmsPackageEntity> {
    await this.timedExecute(
      'insert',
      `insert into ${PROFILE_CMS_PACKAGES_TABLE} (
        id,
        profile_id,
        profile_handle,
        package_id,
        version,
        status,
        cms_package,
        payload_hash,
        package_hash,
        primary_path,
        is_primary,
        created_by_profile_id,
        published_by_profile_id,
        created_at,
        updated_at,
        validated_at,
        published_at,
        failed_at,
        archived_at,
        superseded_by_id,
        validation_result,
        validation_error,
        storage_receipts,
        storage_provider,
        storage_uri,
        storage_content_hash,
        storage_provider_content_id,
        storage_recorded_at,
        storage_pinned,
        storage_canonical
      ) values (
        :id,
        :profile_id,
        :profile_handle,
        :package_id,
        :version,
        :status,
        :cms_package,
        :payload_hash,
        :package_hash,
        :primary_path,
        :is_primary,
        :created_by_profile_id,
        :published_by_profile_id,
        :created_at,
        :updated_at,
        :validated_at,
        :published_at,
        :failed_at,
        :archived_at,
        :superseded_by_id,
        :validation_result,
        :validation_error,
        :storage_receipts,
        :storage_provider,
        :storage_uri,
        :storage_content_hash,
        :storage_provider_content_id,
        :storage_recorded_at,
        :storage_pinned,
        :storage_canonical
      )`,
      this.toParams(entity),
      ctx
    );
    return this.findByIdOrThrow(entity.id, ctx);
  }

  async findById(
    id: string,
    ctx: RequestContext
  ): Promise<ProfileCmsPackageEntity | null> {
    return this.hydrate(
      await this.timedOneOrNull<ProfileCmsPackageEntity>(
        'findById',
        `select * from ${PROFILE_CMS_PACKAGES_TABLE} where id = :id`,
        { id },
        ctx
      )
    );
  }

  async findByIdOrThrow(
    id: string,
    ctx: RequestContext
  ): Promise<ProfileCmsPackageEntity> {
    const entity = await this.findById(id, ctx);
    if (!entity) {
      throw new Error(`Profile CMS package ${id} was not found`);
    }
    return entity;
  }

  async findByVersion(
    profileId: string,
    packageId: string,
    version: number,
    ctx: RequestContext
  ): Promise<ProfileCmsPackageEntity | null> {
    return this.hydrate(
      await this.timedOneOrNull<ProfileCmsPackageEntity>(
        'findByVersion',
        `select * from ${PROFILE_CMS_PACKAGES_TABLE}
         where profile_id = :profileId and package_id = :packageId and version = :version`,
        { profileId, packageId, version },
        ctx
      )
    );
  }

  async findByHash(
    packageHash: string,
    ctx: RequestContext
  ): Promise<ProfileCmsPackageEntity[]> {
    return this.hydrateMany(
      await this.timedExecute<ProfileCmsPackageEntity>(
        'findByHash',
        `select * from ${PROFILE_CMS_PACKAGES_TABLE}
         where package_hash = :packageHash
         order by published_at desc, updated_at desc
         limit 20`,
        { packageHash },
        ctx
      )
    );
  }

  async listByProfile(
    profileId: string,
    includePrivate: boolean,
    ctx: RequestContext
  ): Promise<ProfileCmsPackageEntity[]> {
    const statusFilter = includePrivate
      ? ''
      : `and status = '${ProfileCmsPackageStatus.PUBLISHED}'`;
    return this.hydrateMany(
      await this.timedExecute<ProfileCmsPackageEntity>(
        'listByProfile',
        `select * from ${PROFILE_CMS_PACKAGES_TABLE}
         where profile_id = :profileId ${statusFilter}
         order by version desc, updated_at desc`,
        { profileId },
        ctx
      )
    );
  }

  async findPrimaryPublishedByHandle(
    handle: string,
    ctx: RequestContext
  ): Promise<ProfileCmsPackageEntity | null> {
    return this.hydrate(
      await this.timedOneOrNull<ProfileCmsPackageEntity>(
        'findPrimaryPublishedByHandle',
        `select * from ${PROFILE_CMS_PACKAGES_TABLE}
         where lower(profile_handle) = lower(:handle)
           and status = '${ProfileCmsPackageStatus.PUBLISHED}'
           and is_primary = true
         order by published_at desc, updated_at desc
         limit 1`,
        { handle },
        ctx
      )
    );
  }

  async markValidating(
    id: string,
    now: number,
    ctx: RequestContext
  ): Promise<void> {
    await this.updateStatus(
      {
        id,
        status: ProfileCmsPackageStatus.VALIDATING,
        updated_at: now,
        validated_at: null,
        failed_at: null,
        validation_result: null,
        validation_error: null
      },
      ctx
    );
  }

  async markFailed(
    id: string,
    validationResult: unknown,
    validationError: string,
    now: number,
    ctx: RequestContext
  ): Promise<void> {
    await this.updateStatus(
      {
        id,
        status: ProfileCmsPackageStatus.FAILED,
        updated_at: now,
        validated_at: now,
        failed_at: now,
        validation_result: JSON.stringify(validationResult),
        validation_error: validationError
      },
      ctx
    );
  }

  async supersedePrimaryForProfile(
    profileId: string,
    supersededById: string,
    now: number,
    ctx: RequestContext
  ): Promise<void> {
    await this.timedExecute(
      'supersedePrimaryForProfile',
      `update ${PROFILE_CMS_PACKAGES_TABLE}
       set status = :status,
           is_primary = false,
           superseded_by_id = :supersededById,
           updated_at = :now
       where profile_id = :profileId
         and status = '${ProfileCmsPackageStatus.PUBLISHED}'
         and is_primary = true
         and id <> :supersededById`,
      {
        profileId,
        supersededById,
        now,
        status: ProfileCmsPackageStatus.SUPERSEDED
      },
      ctx
    );
  }

  async markPublished(
    id: string,
    publishedByProfileId: string,
    validationResult: unknown,
    now: number,
    ctx: RequestContext
  ): Promise<void> {
    await this.timedExecute(
      'markPublished',
      `update ${PROFILE_CMS_PACKAGES_TABLE}
       set status = :status,
           is_primary = true,
           published_by_profile_id = :publishedByProfileId,
           updated_at = :now,
           validated_at = :now,
           published_at = :now,
           failed_at = null,
           validation_result = :validationResult,
           validation_error = null
       where id = :id`,
      {
        id,
        publishedByProfileId,
        now,
        status: ProfileCmsPackageStatus.PUBLISHED,
        validationResult: JSON.stringify(validationResult)
      },
      ctx
    );
  }

  private async updateStatus(
    fields: {
      readonly id: string;
      readonly status: ProfileCmsPackageStatus;
      readonly updated_at: number;
      readonly validated_at?: number | null;
      readonly failed_at?: number | null;
      readonly validation_result?: string | null;
      readonly validation_error?: string | null;
    },
    ctx: RequestContext
  ): Promise<void> {
    await this.timedExecute(
      'updateStatus',
      `update ${PROFILE_CMS_PACKAGES_TABLE}
       set status = :status,
           updated_at = :updated_at,
           validated_at = :validated_at,
           failed_at = :failed_at,
           validation_result = :validation_result,
           validation_error = :validation_error
       where id = :id`,
      fields,
      ctx
    );
  }

  private hydrateMany(
    rows: ProfileCmsPackageEntity[]
  ): ProfileCmsPackageEntity[] {
    return rows.map((row) => this.hydrate(row)!);
  }

  private hydrate(
    row: ProfileCmsPackageEntity | null
  ): ProfileCmsPackageEntity | null {
    if (!row) {
      return null;
    }
    return {
      ...row,
      cms_package: parseJsonColumn(row.cms_package),
      validation_result: parseJsonColumn(row.validation_result),
      storage_receipts: parseJsonColumn(row.storage_receipts),
      is_primary: !!row.is_primary,
      storage_pinned: nullableBoolean(row.storage_pinned),
      storage_canonical: nullableBoolean(row.storage_canonical)
    };
  }

  private toParams(
    entity: NewProfileCmsPackageEntity
  ): Record<string, unknown> {
    return {
      ...entity,
      cms_package: JSON.stringify(entity.cms_package),
      validation_result:
        entity.validation_result === null ||
        entity.validation_result === undefined
          ? null
          : JSON.stringify(entity.validation_result),
      storage_receipts: JSON.stringify(entity.storage_receipts),
      is_primary: entity.is_primary ? 1 : 0,
      storage_pinned: nullableBooleanParam(entity.storage_pinned),
      storage_canonical: nullableBooleanParam(entity.storage_canonical),
      validated_at: entity.validated_at ?? null,
      published_at: entity.published_at ?? null,
      failed_at: entity.failed_at ?? null,
      archived_at: entity.archived_at ?? null
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

  private async timedOneOrNull<T>(
    timerName: string,
    sql: string,
    params: Record<string, unknown>,
    ctx: RequestContext
  ): Promise<T | null> {
    ctx.timer?.start(`${this.constructor.name}->${timerName}`);
    try {
      return await this.db.oneOrNull<T>(
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
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function nullableBoolean(value: unknown): boolean | null {
  if (value === null || value === undefined) {
    return null;
  }
  return !!value;
}

function nullableBooleanParam(
  value: boolean | null | undefined
): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  return value ? 1 : 0;
}

export const profileCmsPackagesDb = new ProfileCmsPackagesDb(dbSupplier);
