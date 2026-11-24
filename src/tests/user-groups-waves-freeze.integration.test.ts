import 'reflect-metadata';
import { mock } from 'ts-jest-mocker';
import { UserGroupsService } from '@/api/community-members/user-groups.service';
import {
  USER_GROUP_VISIBILITY_REQUESTS_TABLE,
  USER_GROUPS_TABLE
} from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { Time } from '@/time';
import { UserGroupsDb } from '@/user-groups/user-groups.db';
import {
  WAVES_FROZEN_GROUP_MESSAGE,
  WAVES_FROZEN_GROUP_VISIBILITY_MESSAGE,
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
const AT = 'WAVES_FREEZE_AT';
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
const directMessageGroup = group(true);

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

async function isVisible(id: string): Promise<boolean> {
  const rows = await sqlExecutor.execute<{ visible: unknown }>(
    `select visible from ${USER_GROUPS_TABLE} where id = :id`,
    { id }
  );
  return Boolean(rows[0]?.visible);
}

describeWithSeed(
  'POST /groups/:id/visible during the waves freeze',
  [
    withIdentities([creator]),
    withUserGroups([waveGroup, newVersion, directMessageGroup]),
    withWaves([
      aWave({ visibility_group_id: waveGroup.id }),
      aWave({
        is_direct_message: true,
        visibility_group_id: directMessageGroup.id,
        chat_group_id: directMessageGroup.id
      })
    ])
  ],
  () => {
    const groupsDb = new UserGroupsDb(() => sqlExecutor);
    const service = new UserGroupsService(groupsDb, mock());
    const original: Record<string, string | undefined> = {};
    beforeAll(() => {
      for (const name of [FLAG, AT]) original[name] = process.env[name];
    });
    beforeEach(() => {
      for (const name of [FLAG, AT]) delete process.env[name];
    });
    afterEach(() => {
      jest.restoreAllMocks();
    });
    afterAll(() => {
      for (const name of [FLAG, AT]) {
        if (original[name] === undefined) delete process.env[name];
        else process.env[name] = original[name];
      }
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

    it('neither hides a group a wave uses nor writes a receipt', async () => {
      process.env[FLAG] = 'true';
      const hide = service.changeVisibility(
        {
          group_id: waveGroup.id,
          old_version_id: null,
          visible: false,
          profile_id: creatorKey.profile_id,
          idempotencyKey: 'hide'
        },
        {}
      );
      await expect(hide).rejects.toThrow(WAVES_FROZEN_GROUP_VISIBILITY_MESSAGE);
      expect(await receipts()).toEqual([]);
      expect(await isVisible(waveGroup.id)).toBe(true);
    });

    it('refuses the replacement when the freeze starts during its lock wait', async () => {
      const freeze = Date.UTC(2026, 10, 25);
      process.env[AT] = new Date(freeze).toISOString();
      const now = jest.spyOn(Time, 'currentMillis').mockReturnValue(freeze - 1);
      const lock = groupsDb.lockForVisibilityChange.bind(groupsDb);
      jest
        .spyOn(groupsDb, 'lockForVisibilityChange')
        .mockImplementation(async (id, connection) => {
          await lock(id, connection);
          now.mockReturnValue(freeze + 1);
        });
      await expect(
        service.changeVisibility(replaceWaveGroup('during-the-wait'), {})
      ).rejects.toThrow(WAVES_FROZEN_GROUP_MESSAGE);
      // The receipt reserved in the transaction was rolled back with it.
      expect(await receipts()).toEqual([]);
      expect(await groupName(waveGroup.id)).toBe(waveGroup.name);
      expect(await groupName(newVersion.id)).toBe(newVersion.name);
    });

    it("still hides a direct message's group: direct messages are chat", async () => {
      process.env[FLAG] = 'true';
      await service.changeVisibility(
        {
          group_id: directMessageGroup.id,
          old_version_id: null,
          visible: false,
          profile_id: creatorKey.profile_id,
          idempotencyKey: 'hide-dm'
        },
        {}
      );
      expect(await isVisible(directMessageGroup.id)).toBe(false);
      expect(await receipts()).toEqual([true]);
    });
  }
);
