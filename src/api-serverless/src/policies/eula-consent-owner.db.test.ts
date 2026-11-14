import 'reflect-metadata';
import { EULA_CONSENT_TABLE } from '@/constants';
import { EULAConsent } from '@/entities/IEULAPolicy';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { CURRENT_EULA_VERSION } from './eula-policy';
import { deleteOwnedEULAConsent, saveEULAConsent } from './policies.db';

const OWNED: EULAConsent = {
  device_id: 'owned-device',
  platform: 'ios',
  accepted_at: 1_000,
  eula_version: CURRENT_EULA_VERSION,
  profile_id: 'owner-profile'
};

const UNOWNED: EULAConsent = {
  device_id: 'unowned-device',
  platform: 'android',
  accepted_at: 1_000,
  eula_version: CURRENT_EULA_VERSION,
  profile_id: null
};

async function findRow(deviceId: string): Promise<EULAConsent | null> {
  return sqlExecutor.oneOrNull<EULAConsent>(
    `SELECT device_id, platform, accepted_at, eula_version, profile_id
      FROM ${EULA_CONSENT_TABLE}
      WHERE device_id = :deviceId`,
    { deviceId }
  );
}

describeWithSeed(
  'EULA consent ownership',
  { table: EULA_CONSENT_TABLE, rows: [OWNED, UNOWNED] },
  () => {
    it('records the saving profile as owner when the row is created', async () => {
      await saveEULAConsent(
        'new-device',
        'ios',
        CURRENT_EULA_VERSION,
        'saver-profile'
      );
      await saveEULAConsent('anonymous-device', 'ios', CURRENT_EULA_VERSION);

      expect(await findRow('new-device')).toMatchObject({
        profile_id: 'saver-profile'
      });
      expect(await findRow('anonymous-device')).toMatchObject({
        profile_id: null
      });
    });

    it('keeps the existing owner, including none, on re-save', async () => {
      await saveEULAConsent(
        OWNED.device_id,
        'android',
        CURRENT_EULA_VERSION,
        'other-profile'
      );
      await saveEULAConsent(
        UNOWNED.device_id,
        'ios',
        CURRENT_EULA_VERSION,
        'other-profile'
      );

      const owned = await findRow(OWNED.device_id);
      expect(owned).toMatchObject({
        platform: 'android',
        profile_id: OWNED.profile_id
      });
      expect(Number(owned!.accepted_at)).toBeGreaterThan(OWNED.accepted_at);
      expect(await findRow(UNOWNED.device_id)).toMatchObject({
        platform: 'ios',
        profile_id: null
      });
    });

    it('deletes a row for its owner', async () => {
      await deleteOwnedEULAConsent(OWNED.device_id, OWNED.profile_id!);

      expect(await findRow(OWNED.device_id)).toBeNull();
    });

    it('leaves a row owned by another profile', async () => {
      await deleteOwnedEULAConsent(OWNED.device_id, 'other-profile');

      expect(await findRow(OWNED.device_id)).not.toBeNull();
    });

    it('leaves a row without an owner', async () => {
      await deleteOwnedEULAConsent(UNOWNED.device_id, 'owner-profile');

      expect(await findRow(UNOWNED.device_id)).not.toBeNull();
    });

    it('completes without error when the device has no row', async () => {
      await expect(
        deleteOwnedEULAConsent('missing-device', 'owner-profile')
      ).resolves.toBeUndefined();
      expect(await findRow(OWNED.device_id)).not.toBeNull();
      expect(await findRow(UNOWNED.device_id)).not.toBeNull();
    });
  }
);
