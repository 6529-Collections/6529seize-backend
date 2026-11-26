import { PROFILE_CMS_PUBLISH_SIGNATURES_TABLE } from '@/constants';
import { ProfileCmsPublishSignatureEntity } from '@/entities/IProfileCmsPublishSignature';
import { RequestContext } from '@/request.context';
import {
  dbSupplier,
  LazyDbAccessCompatibleService,
  SqlExecutor
} from '@/sql-executor';
import {
  ProfileCmsPrivateLog,
  profileCmsPrivateLog
} from '@/profile-cms/personal-log/profile-cms-private-log';

export type NewProfileCmsPublishSignatureEntity =
  ProfileCmsPublishSignatureEntity;

export class ProfileCmsPublishSignaturesDb extends LazyDbAccessCompatibleService {
  constructor(
    supplier: () => SqlExecutor = dbSupplier,
    private readonly privateLog: Pick<
      ProfileCmsPrivateLog,
      'logged'
    > = profileCmsPrivateLog
  ) {
    super(supplier);
  }

  /**
   * Records a consumed publish signature; false if it was used already. With
   * the private log on, a new row is logged in the write's transaction.
   */
  async insertConsumed(
    entity: NewProfileCmsPublishSignatureEntity,
    ctx: RequestContext
  ): Promise<boolean> {
    try {
      await this.privateLog.logged(
        ctx,
        [['cms.publish-signature', entity.id]],
        (txCtx) => this.insertRow(entity, txCtx)
      );
      return true;
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        return false;
      }
      throw error;
    }
  }

  private async insertRow(
    entity: NewProfileCmsPublishSignatureEntity,
    ctx: RequestContext
  ): Promise<void> {
    await this.timedExecute(
      'insertConsumed',
      `insert into ${PROFILE_CMS_PUBLISH_SIGNATURES_TABLE} (
          id,
          typed_data_hash,
          profile_id,
          package_db_id,
          package_id,
          package_version,
          package_hash,
          signer_address,
          deadline,
          created_at
        ) values (
          :id,
          :typed_data_hash,
          :profile_id,
          :package_db_id,
          :package_id,
          :package_version,
          :package_hash,
          :signer_address,
          :deadline,
          :created_at
        )`,
      this.toParams(entity),
      ctx
    );
  }

  private toParams(
    entity: NewProfileCmsPublishSignatureEntity
  ): Record<string, unknown> {
    return { ...entity };
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
        ctx.connection ? { wrappedConnection: ctx.connection } : undefined
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->${timerName}`);
    }
  }
}

function isDuplicateKeyError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === 'ER_DUP_ENTRY'
  );
}

export const profileCmsPublishSignaturesDb =
  new ProfileCmsPublishSignaturesDb();
