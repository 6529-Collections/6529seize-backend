import { randomUUID } from 'node:crypto';
import { PROFILES_TABLE, PROFILE_CMS_UPLOADS_TABLE } from '@/constants';
import { ProfileCmsUploadEntity } from '@/entities/IProfileCmsUpload';
import { CustomApiCompliantException, NotFoundException } from '@/exceptions';
import { CmsPackageV1 } from '@/profile-cms/protocol/v1';
import { RequestContext } from '@/request.context';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';

type Receipt = CmsPackageV1['storage'][number];
export interface ProfileCmsUploadReservation {
  id: string;
  token?: string;
  receipt?: Receipt;
}

export class ProfileCmsUploadsDb extends LazyDbAccessCompatibleService {
  async reserve(
    id: string,
    profileId: string,
    packageDbId: string,
    now: number,
    ctx: RequestContext
  ): Promise<ProfileCmsUploadReservation> {
    ctx.timer?.start('ProfileCmsUploadsDb->reserve');
    return this.db
      .executeNativeQueriesInTransaction(async (connection) => {
        const options = { wrappedConnection: connection };
        // Serialize quota checks, including the first upload for a profile.
        const profile = await this.db.oneOrNull<{ external_id: string }>(
          `select external_id from ${PROFILES_TABLE} where external_id = :profileId for update`,
          { profileId },
          options
        );
        if (!profile) throw new NotFoundException('CMS profile not found');
        const row = await this.db.oneOrNull<ProfileCmsUploadEntity>(
          `select * from ${PROFILE_CMS_UPLOADS_TABLE} where id = :id for update`,
          { id },
          options
        );
        if (row?.receipt) {
          return {
            id,
            receipt:
              typeof row.receipt === 'string'
                ? JSON.parse(row.receipt)
                : (row.receipt as Receipt)
          };
        }
        if (row?.lease_until && Number(row.lease_until) > now) {
          throw new CustomApiCompliantException(
            409,
            'CMS upload is already in progress; retry shortly',
            'cms_upload_in_progress'
          );
        }
        const quota = await this.db.oneOrNull<{ attempts: number }>(
          `select coalesce(sum(attempts), 0) as attempts from ${PROFILE_CMS_UPLOADS_TABLE} where profile_id = :profileId and updated_at >= :since`,
          { profileId, since: now - 86400000 },
          options
        );
        if (Number(quota?.attempts ?? 0) >= 32) {
          throw new CustomApiCompliantException(
            429,
            'CMS storage upload limit reached; try again tomorrow',
            'cms_upload_quota'
          );
        }
        const token = randomUUID();
        await this.db.execute(
          `insert into ${PROFILE_CMS_UPLOADS_TABLE} (id, profile_id, package_db_id, attempts, updated_at, lease_token, lease_until, receipt) values (:id, :profileId, :packageDbId, 1, :now, :token, :until, null) on duplicate key update attempts = if(updated_at < :since, 1, attempts + 1), updated_at = :now, lease_token = :token, lease_until = :until`,
          {
            id,
            profileId,
            packageDbId,
            now,
            since: now - 86400000,
            token,
            until: now + 120000
          },
          options
        );
        return { id, token };
      })
      .finally(() => ctx.timer?.stop('ProfileCmsUploadsDb->reserve'));
  }

  async complete(
    reservation: ProfileCmsUploadReservation,
    receipt: Receipt,
    ctx: RequestContext
  ): Promise<void> {
    ctx.timer?.start('ProfileCmsUploadsDb->complete');
    await this.db
      .executeNativeQueriesInTransaction(async (connection) => {
        const options = { wrappedConnection: connection };
        const row = await this.db.oneOrNull<ProfileCmsUploadEntity>(
          `select * from ${PROFILE_CMS_UPLOADS_TABLE} where id = :id for update`,
          { id: reservation.id },
          options
        );
        if (!row || row.lease_token !== reservation.token) {
          throw new CustomApiCompliantException(
            409,
            'CMS upload lease expired; retry to retrieve the current receipt',
            'cms_upload_lease_expired'
          );
        }
        await this.db.execute(
          `update ${PROFILE_CMS_UPLOADS_TABLE} set receipt = :receipt, lease_token = null, lease_until = null where id = :id and lease_token = :token`,
          {
            id: reservation.id,
            token: reservation.token,
            receipt: JSON.stringify(receipt)
          },
          options
        );
      })
      .finally(() => ctx.timer?.stop('ProfileCmsUploadsDb->complete'));
  }

  async release(
    reservation: ProfileCmsUploadReservation,
    ctx: RequestContext
  ): Promise<void> {
    ctx.timer?.start('ProfileCmsUploadsDb->release');
    await this.db
      .execute(
        `update ${PROFILE_CMS_UPLOADS_TABLE} set lease_token = null, lease_until = null where id = :id and lease_token = :token`,
        { id: reservation.id, token: reservation.token },
        ctx.connection ? { wrappedConnection: ctx.connection } : undefined
      )
      .finally(() => ctx.timer?.stop('ProfileCmsUploadsDb->release'));
  }
}

export const profileCmsUploadsDb = new ProfileCmsUploadsDb(dbSupplier);
