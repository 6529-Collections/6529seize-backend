import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import {
  CONTENT_MODERATION_PROFILE_BLOCKS_TABLE,
  PROFILE_GROUPS_TABLE
} from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { anIdentity, withIdentities } from '@/tests/fixtures/identity.fixture';
import { withProfileGroups } from '@/tests/fixtures/profile-group.fixture';
import {
  aUserGroup,
  withUserGroups
} from '@/tests/fixtures/user-group.fixture';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import { WavesApiDb } from './waves.api.db';

const reader = anIdentity({});
const other = anIdentity({});
const bystander = anIdentity({});
const dmProfileGroupId = randomUUID();
const dmGroup = aUserGroup({
  is_direct_message: true,
  profile_group_id: dmProfileGroupId
});
const dmWave = aWave({
  is_direct_message: true,
  chat_group_id: dmGroup.id,
  visibility_group_id: dmGroup.id
});

async function idCollations(): Promise<string[]> {
  const rows = await sqlExecutor.execute<{ collation_name: string }>(
    `select collation_name as collation_name
     from information_schema.columns
     where table_schema = database() and table_name = :table
     order by ordinal_position`,
    { table: PROFILE_GROUPS_TABLE }
  );
  return rows.map((row) => row.collation_name);
}

async function setIdCollation(charset: string, collation: string) {
  await sqlExecutor.execute(
    `alter table ${PROFILE_GROUPS_TABLE}
       modify profile_group_id varchar(50) character set ${charset} collate ${collation} not null,
       modify profile_id varchar(100) character set ${charset} collate ${collation} not null`
  );
}

describeWithSeed(
  'DM blocked-member check across profile_groups collations',
  [
    withIdentities([reader, other, bystander]),
    withUserGroups([dmGroup]),
    withWaves([dmWave]),
    withProfileGroups([
      { profile_group_id: dmProfileGroupId, profile_id: reader.profile_id! },
      { profile_group_id: dmProfileGroupId, profile_id: other.profile_id! }
    ]),
    {
      table: CONTENT_MODERATION_PROFILE_BLOCKS_TABLE,
      rows: [
        {
          blocker_profile_id: reader.profile_id!,
          blocked_profile_id: other.profile_id!,
          created_at: 1
        }
      ]
    }
  ],
  () => {
    const repo = new WavesApiDb(() => sqlExecutor);

    async function mutedFor(readerId: string): Promise<boolean> {
      const metrics = await repo.findWaveReaderMetricsByWaveIds(
        { readerId, waveIds: [dmWave.id] },
        {}
      );
      return metrics[dmWave.id]!.muted;
    }

    it.each([
      ['legacy utf8mb3_bin ids (before #2355)', 'utf8mb3', 'utf8mb3_bin'],
      ['schema-collation ids (after #2355)', 'utf8mb4', 'utf8mb4_0900_ai_ci']
    ])(
      'treats a blocked one-to-one counterpart as muted with %s',
      async (_state, charset, collation) => {
        const original = await idCollations();
        try {
          await setIdCollation(charset, collation);
          await expect(mutedFor(reader.profile_id!)).resolves.toBe(true);
          await expect(mutedFor(other.profile_id!)).resolves.toBe(false);
          await expect(mutedFor(bystander.profile_id!)).resolves.toBe(false);
        } finally {
          const [restoreCollation] = original;
          await setIdCollation(
            restoreCollation!.startsWith('utf8mb3') ? 'utf8mb3' : 'utf8mb4',
            restoreCollation!
          );
        }
      }
    );
  }
);
