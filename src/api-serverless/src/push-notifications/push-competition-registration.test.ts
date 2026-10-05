import 'reflect-metadata';
import { PUSH_NOTIFICATION_DEVICES_TABLE } from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { registerInstallationDevice } from './push-installation.db';
import { savePushNotificationDevice } from './push-notifications.db';

const device = (profileId: string, includeCompetitions?: boolean) => ({
  device_id: 'native-test-phone',
  profile_id: profileId,
  token: 'native-test-token',
  platform: 'ios',
  include_competitions: includeCompetitions
});
const credential = {
  installation_secret: 'a'.repeat(64),
  installation_revision: 0
};
const capabilities = () =>
  sqlExecutor.execute<{ profile_id: string; include_competitions: boolean }>(
    `SELECT profile_id, include_competitions FROM ${PUSH_NOTIFICATION_DEVICES_TABLE} ORDER BY profile_id`
  );

describeWithSeed('push competition support registration', [], () => {
  it('defaults legacy registrations to false and clears support on re-registration omission', async () => {
    await registerInstallationDevice(device('A'), {}, {});
    expect(await capabilities()).toEqual([
      { profile_id: 'A', include_competitions: false }
    ]);
    await registerInstallationDevice(device('A', true), {}, {});
    expect(await capabilities()).toEqual([
      { profile_id: 'A', include_competitions: true }
    ]);
    await registerInstallationDevice(device('A'), {}, {});
    expect(await capabilities()).toEqual([
      { profile_id: 'A', include_competitions: false }
    ]);
  });

  it('does not give unverified registration authority over another profile capability', async () => {
    await registerInstallationDevice(device('A', true), {}, {});
    await registerInstallationDevice(device('B', true), {}, {});
    await registerInstallationDevice(device('A'), {}, {});
    expect(await capabilities()).toEqual([
      { profile_id: 'A', include_competitions: false },
      { profile_id: 'B', include_competitions: true }
    ]);
  });

  it('updates all verified installation profiles and requires the installation credential', async () => {
    await registerInstallationDevice(device('A'), credential, {});
    await registerInstallationDevice(device('B', true), credential, {});
    expect(await capabilities()).toEqual([
      { profile_id: 'A', include_competitions: true },
      { profile_id: 'B', include_competitions: true }
    ]);
    await expect(
      registerInstallationDevice(device('A', false), {}, {})
    ).rejects.toThrow('Invalid push installation credential');
    await expect(
      registerInstallationDevice(
        device('A', false),
        { ...credential, installation_revision: 1 },
        {}
      )
    ).rejects.toThrow('Stale push installation revision');
    expect(await capabilities()).toEqual([
      { profile_id: 'A', include_competitions: true },
      { profile_id: 'B', include_competitions: true }
    ]);
    await registerInstallationDevice(device('A'), credential, {});
    expect(await capabilities()).toEqual([
      { profile_id: 'A', include_competitions: false },
      { profile_id: 'B', include_competitions: false }
    ]);
  });

  it('preserves capability defaults in the legacy storage helper', async () => {
    await savePushNotificationDevice(device('A', true));
    expect(await capabilities()).toEqual([
      { profile_id: 'A', include_competitions: true }
    ]);
    await savePushNotificationDevice(device('A'));
    expect(await capabilities()).toEqual([
      { profile_id: 'A', include_competitions: false }
    ]);
  });
});
