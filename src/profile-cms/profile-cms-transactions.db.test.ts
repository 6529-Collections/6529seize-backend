import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { sqlExecutor } from '@/sql-executor';
import {
  ProfileCmsPackagesDb,
  NewProfileCmsPackageEntity
} from './profile-cms-packages.db';
import { ProfileCmsUploadsDb } from './profile-cms-uploads.db';
import { ProfileCmsPackageStatus } from '@/entities/IProfileCmsPackage';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aProfile, withProfiles } from '@/tests/fixtures/profile.fixture';
import { createValidProfileCmsPackage } from '@/tests/fixtures/profile-cms-package.fixture';

const profileId = 'cms-concurrency-test';
const profile = aProfile({
  external_id: profileId,
  handle: 'CmsConcurrency',
  primary_wallet: '0x0000000000000000000000000000000000000001'
});
const packages = new ProfileCmsPackagesDb(() => sqlExecutor);
const uploads = new ProfileCmsUploadsDb(() => sqlExecutor);
const packageJson = createValidProfileCmsPackage({
  handle: profile.handle,
  profileId
});
const receipt = packageJson.storage[0];

function draft(version: number): NewProfileCmsPackageEntity {
  return {
    id: randomUUID(),
    profile_id: profileId,
    profile_handle: profile.handle,
    package_id: packageJson.package_id,
    version,
    status: ProfileCmsPackageStatus.DRAFT,
    cms_package: packageJson,
    payload_hash: packageJson.integrity.payload_hash,
    package_hash: packageJson.integrity.package_hash,
    primary_path: `/${profile.handle}/index.html`,
    is_primary: false,
    production_valid: false,
    created_by_profile_id: profileId,
    published_by_profile_id: null,
    created_at: 1000,
    updated_at: 1000,
    validated_at: null,
    published_at: null,
    failed_at: null,
    archived_at: null,
    superseded_by_id: null,
    validation_result: null,
    validation_error: null,
    storage_receipts: packageJson.storage,
    storage_provider: null,
    storage_uri: null,
    storage_content_hash: null,
    storage_provider_content_id: null,
    storage_recorded_at: null,
    storage_pinned: null,
    storage_canonical: null
  };
}

describeWithSeed(
  'CMS database serialization and retry safety',
  withProfiles([profile]),
  () => {
    it('allocates distinct sequential versions during simultaneous first saves', async () => {
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          packages.executeNativeQueriesInTransaction(async (connection) => {
            const ctx = { connection };
            await packages.lockProfilePackagesForUpdate(profileId, ctx);
            const version = await packages.getNextVersion(
              profileId,
              packageJson.package_id,
              ctx
            );
            return packages.insert(draft(version), ctx);
          })
        )
      );
      expect(
        results.map((row) => row.version).sort((left, right) => left - right)
      ).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    });

    it('grants exactly one concurrent upload lease and reuses the recorded receipt', async () => {
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () =>
          uploads.reserve('one-upload', profileId, 'draft', 1000, {})
        )
      );
      const successful = results.filter(
        (result) => result.status === 'fulfilled'
      );
      expect(successful).toHaveLength(1);
      const reservation = successful[0];
      if (reservation.status !== 'fulfilled')
        throw new Error('missing reservation');
      await uploads.complete(reservation.value, receipt, {});
      await expect(
        uploads.reserve('one-upload', profileId, 'draft', 2000, {})
      ).resolves.toMatchObject({ receipt });
    });

    it('rejects a stale upload worker after another worker takes its expired lease', async () => {
      const old = await uploads.reserve(
        'expired-upload',
        profileId,
        'draft',
        1000,
        {}
      );
      const current = await uploads.reserve(
        'expired-upload',
        profileId,
        'draft',
        122000,
        {}
      );
      await expect(uploads.complete(old, receipt, {})).rejects.toMatchObject({
        code: 'cms_upload_lease_expired'
      });
      await uploads.complete(current, receipt, {});
      await expect(
        uploads.reserve('expired-upload', profileId, 'draft', 123000, {})
      ).resolves.toMatchObject({ receipt });
    });

    it('enforces the upload budget across different package ids in one profile', async () => {
      for (let index = 0; index < 32; index++)
        await uploads.reserve(
          `quota-${index}`,
          profileId,
          `draft-${index}`,
          1000,
          {}
        );
      await expect(
        uploads.reserve('quota-over', profileId, 'another-draft', 1000, {})
      ).rejects.toMatchObject({ code: 'cms_upload_quota' });
    });

    it('allows only one of two simultaneous first publications with the same expected empty pointer', async () => {
      const drafts = await Promise.all([
        packages.insert(draft(1), {}),
        packages.insert(draft(2), {})
      ]);
      const results = await Promise.allSettled(
        drafts.map((row) =>
          packages.executeNativeQueriesInTransaction(async (connection) => {
            const ctx = { connection };
            await packages.lockProfilePackagesForUpdate(profileId, ctx);
            const primary =
              await packages.findPrimaryPublishedByProfileIdForUpdate(
                profileId,
                ctx
              );
            if (primary) throw new Error('stale primary');
            await packages.markPublished(
              row.id,
              profileId,
              { valid: true },
              2000,
              ctx
            );
          })
        )
      );
      expect(
        results.filter((result) => result.status === 'fulfilled')
      ).toHaveLength(1);
      expect(
        (await packages.listByProfile(profileId, true, {})).filter(
          (row) => row.is_primary
        )
      ).toHaveLength(1);
    });

    it('renews the activity quota after its window expires', async () => {
      const first = await uploads.reserve(
        'old-upload',
        profileId,
        'draft',
        1000,
        {}
      );
      await uploads.release(first, {});
      const tomorrow = 86402000;
      await uploads.reserve('old-upload', profileId, 'draft', tomorrow, {});
      for (let index = 0; index < 31; index++)
        await uploads.reserve(`new-${index}`, profileId, 'draft', tomorrow, {});
      await expect(
        uploads.reserve('over-budget', profileId, 'draft', tomorrow, {})
      ).rejects.toMatchObject({ code: 'cms_upload_quota' });
    });

    it('keeps a draft retryable and cannot downgrade an already published package on late validation failure', async () => {
      const row = await packages.insert(draft(1), {});
      await packages.recordDraftFailure(
        row.id,
        { valid: false },
        'invalid content',
        2000,
        {}
      );
      expect((await packages.findById(row.id, {}))?.status).toBe(
        ProfileCmsPackageStatus.DRAFT
      );
      await packages.markPublished(
        row.id,
        profileId,
        { valid: true },
        3000,
        {}
      );
      await packages.recordDraftFailure(
        row.id,
        { valid: false },
        'late failure',
        4000,
        {}
      );
      expect(await packages.findById(row.id, {})).toMatchObject({
        status: ProfileCmsPackageStatus.PUBLISHED,
        is_primary: true,
        production_valid: true,
        validation_error: null
      });
    });
  }
);
