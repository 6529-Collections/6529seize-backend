import 'reflect-metadata';
import { mock } from 'ts-jest-mocker';
import { UserGroupsService } from '@/api/community-members/user-groups.service';
import {
  USER_GROUP_VISIBILITY_REQUESTS_TABLE,
  USER_GROUPS_TABLE
} from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { UserGroupsDb } from '@/user-groups/user-groups.db';
import {
  WAVES_FROZEN_GROUP_MESSAGE,
  WavesFrozenException
} from '@/waves-freeze/waves-freeze';
import {
  aRandomIdentityKey,
  anIdentity,
  withIdentities
} from './fixtures/identity.fixture';
import { aUserGroup, withUserGroups } from './fixtures/user-group.fixture';
import { aWave, withWaves } from './fixtures/wave.fixture';

const FLAG = 'FEATURE_WAVES_FROZEN';
const creatorKey = aRandomIdentityKey();
const creator = anIdentity({}, creatorKey);
const group = (visible: boolean) =>
  aUserGroup({
    created_by: creatorKey.profile_id,
    visible,
    is_direct_message: false
  });
const waveGroup = group(true);
const newVersion = group(false);

function replaceWaveGroup(idempotencyKey: string, visible = true) {
  return {
    group_id: newVersion.id,
    old_version_id: waveGroup.id,
    visible,
    profile_id: creatorKey.profile_id,
    idempotencyKey
  };
}

async function receipts(): Promise<boolean[]> {
  const rows = await sqlExecutor.execute<{ completed: unknown }>(
    `select completed from ${USER_GROUP_VISIBILITY_REQUESTS_TABLE}`
  );
  return rows.map((row) => Boolean(row.completed));
}

async function groupName(id: string): Promise<string | null> {
  const rows = await sqlExecutor.execute<{ name: string }>(
    `select name from ${USER_GROUPS_TABLE} where id = :id`,
    { id }
  );
  return rows[0]?.name ?? null;
}

describeWithSeed(
  'POST /groups/:id/visible with old_version_id during the waves freeze',
  [
    withIdentities([creator]),
    withUserGroups([waveGroup, newVersion]),
    withWaves([aWave({ visibility_group_id: waveGroup.id })])
  ],
  () => {
    const service = new UserGroupsService(
      new UserGroupsDb(() => sqlExecutor),
      mock()
    );
    const original = process.env[FLAG];
    afterEach(() => {
      if (original === undefined) delete process.env[FLAG];
      else process.env[FLAG] = original;
    });

    it('refuses to replace a group a wave uses and writes no receipt', async () => {
      process.env[FLAG] = 'true';
      const result = service.changeVisibility(replaceWaveGroup('first'), {});
      await expect(result).rejects.toBeInstanceOf(WavesFrozenException);
      await expect(result).rejects.toThrow(WAVES_FROZEN_GROUP_MESSAGE);
      expect(await receipts()).toEqual([]);
      expect(await groupName(waveGroup.id)).toBe(waveGroup.name);
      expect(await groupName(newVersion.id)).toBe(newVersion.name);
    });

    it('replaces it when not frozen; a retry after the freeze gets the stored result', async () => {
      delete process.env[FLAG];
      const saved = await service.changeVisibility(
        replaceWaveGroup('before-freeze'),
        {}
      );
      expect(saved.id).toBe(waveGroup.id);
      expect(saved.name).toBe(newVersion.name);
      expect(await groupName(newVersion.id)).toBeNull();
      expect(await receipts()).toEqual([true]);

      process.env[FLAG] = 'true';
      const retried = await service.changeVisibility(
        replaceWaveGroup('before-freeze'),
        {}
      );
      expect(retried.id).toBe(waveGroup.id);
      expect(retried.name).toBe(newVersion.name);
      const otherSave = service.changeVisibility(
        replaceWaveGroup('before-freeze', false),
        {}
      );
      await expect(otherSave).rejects.toThrow(
        'Idempotency key was used for a different group save'
      );
      await expect(
        service.changeVisibility(replaceWaveGroup('during-freeze'), {})
      ).rejects.toBeInstanceOf(WavesFrozenException);
      expect(await receipts()).toEqual([true]);
      expect(await groupName(waveGroup.id)).toBe(newVersion.name);
    });
  }
);
