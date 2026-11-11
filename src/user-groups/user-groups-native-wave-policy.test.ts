import {
  COMPETITIONS_TABLE,
  WAVE_CURATIONS_TABLE,
  WAVES_TABLE
} from '@/constants';
import { WaveType } from '@/entities/IWave';
import { sqlExecutor } from '@/sql-executor';
import { resetTestDatabase } from '@/tests/_setup/testDatabase';
import {
  nativeOriginalPrimaryFixture,
  seedNativeOriginalPrimaryFixture
} from '@/tests/fixtures/native-competition.fixture';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { UserGroupsDb } from './user-groups.db';

const repo = new UserGroupsDb(() => sqlExecutor);

async function seedCurrentCatalog() {
  const chat = aWave(
    {
      participation_group_id: 'native-chat-participants',
      voting_group_id: 'native-chat-voters',
      visibility_group_id: 'viewers',
      chat_group_id: 'chatters',
      admin_group_id: 'admins'
    },
    { id: 'native-shared-hub', serial_no: 1, name: 'Native shared hub' }
  );
  const original = aWave(
    {
      type: WaveType.RANK,
      participation_group_id: 'native-original-participants',
      voting_group_id: 'native-original-voters'
    },
    { id: 'native-original-hub', serial_no: 2, name: 'Native original hub' }
  );
  const dm = aWave(
    {
      is_direct_message: true,
      participation_group_id: 'dm-members',
      visibility_group_id: 'dm-members',
      chat_group_id: 'dm-members',
      admin_group_id: 'dm-members'
    },
    { id: 'native-dm', serial_no: 3, name: 'Native DM' }
  );
  for (const wave of [chat, original, dm]) {
    const row = withWaves([wave]).rows[0];
    await sqlExecutor.bulkInsert(WAVES_TABLE, [row], Object.keys(row));
  }
  await seedNativeOriginalPrimaryFixture(original);
  const sibling = {
    ...nativeOriginalPrimaryFixture(
      aWave(
        {
          type: WaveType.RANK,
          participation_group_id: 'native-sibling-participants',
          voting_group_id: 'native-sibling-voters'
        },
        { id: chat.id, name: 'Native sibling' }
      )
    ),
    id: 'native-sibling',
    legacy_wave_id: null
  };
  const record = Object.fromEntries(
    Object.entries(sibling).map(([key, value]) => [
      key,
      value !== null && typeof value === 'object'
        ? JSON.stringify(value)
        : value
    ])
  );
  await sqlExecutor.bulkInsert(
    COMPETITIONS_TABLE,
    [record],
    Object.keys(record)
  );
  await sqlExecutor.bulkInsert(
    WAVE_CURATIONS_TABLE,
    [
      {
        id: 'curation',
        name: 'Curated chat',
        wave_id: chat.id,
        community_group_id: 'curators',
        created_at: 1,
        updated_at: 1
      }
    ],
    ['id', 'name', 'wave_id', 'community_group_id', 'created_at', 'updated_at']
  );
}

function expectedCatalog() {
  return [
    'admins',
    'chatters',
    'curators',
    'dm-members',
    'native-chat-participants',
    'native-chat-voters',
    'native-original-participants',
    'native-original-voters',
    'native-sibling-participants',
    'native-sibling-voters',
    'viewers'
  ].sort((left, right) => left.localeCompare(right));
}

describe('native wave eligibility group catalogue', () => {
  beforeEach(resetTestDatabase);

  it('uses native CHAT, original and sibling roles while retaining shared and curation roles', async () => {
    await seedCurrentCatalog();
    expect(
      (await repo.getAllWaveRelatedGroups({})).sort((left, right) =>
        left.localeCompare(right)
      )
    ).toEqual(expectedCatalog());
  });

  it('reads the actual catalogue with capture off and obsolete role columns absent', async () => {
    if (
      process.env.NODE_ENV !== 'local' ||
      !process.env.DB_NAME?.includes('_jest_worker_')
    )
      throw new Error('Physical absence requires the disposable Jest database');
    await seedCurrentCatalog();
    const activeCapture = await sqlExecutor.oneOrNull<{ count: number }>(
      `select count(*) as count from information_schema.triggers where trigger_schema=database() and action_statement like '%hub_participation_config%'`
    );
    expect(Number(activeCapture?.count)).toBe(0);
    expect(
      await sqlExecutor.execute(
        'select COLUMN_NAME from information_schema.COLUMNS where TABLE_SCHEMA=database() and TABLE_NAME=:table and COLUMN_NAME in (:columns)',
        {
          table: WAVES_TABLE,
          columns: ['participation_group_id', 'voting_group_id']
        }
      )
    ).toEqual([]);
    expect(
      (await repo.getAllWaveRelatedGroups({})).sort((left, right) =>
        left.localeCompare(right)
      )
    ).toEqual(expectedCatalog());
  });
});
