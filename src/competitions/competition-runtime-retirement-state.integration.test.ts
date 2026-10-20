import {
  COMPETITIONS_TABLE,
  DROP_REAL_VOTE_IN_TIME_TABLE,
  WAVES_TABLE
} from '@/constants';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import {
  installLegacyCompetitionGetFacade,
  legacyGetView
} from './legacy-competition-get-facade';
import {
  assertCompetitionHistoryPreparationAllowed,
  isCompetitionRuntimeRetired
} from './competition-runtime-retirement-state';

describeWithSeed('competition cutover metadata in MySQL', [], () => {
  it('recognizes all native projections and rejects another raw-source preparation', async () => {
    expect(await isCompetitionRuntimeRetired(sqlExecutor)).toBe(true);
    await expect(
      assertCompetitionHistoryPreparationAllowed(sqlExecutor)
    ).rejects.toThrow('retained sources are no longer authoritative');
  });

  it('permits pre-cutover retry when one retained history view still uses its physical source', async () => {
    try {
      await sqlExecutor.execute(
        `create or replace view \`${legacyGetView(DROP_REAL_VOTE_IN_TIME_TABLE)}\` as select * from \`${DROP_REAL_VOTE_IN_TIME_TABLE}\``
      );
      expect(await isCompetitionRuntimeRetired(sqlExecutor)).toBe(false);
      await expect(
        assertCompetitionHistoryPreparationAllowed(sqlExecutor)
      ).resolves.toBeUndefined();
    } finally {
      await installLegacyCompetitionGetFacade(sqlExecutor);
    }
  });

  it('does not mistake the prepared wave configuration fallback for a complete native switch', async () => {
    try {
      await sqlExecutor.execute(
        `create or replace view \`${legacyGetView(WAVES_TABLE)}\` as select c.id,w.type from ${WAVES_TABLE} w left join ${COMPETITIONS_TABLE} c on c.legacy_wave_id=w.id`
      );
      expect(await isCompetitionRuntimeRetired(sqlExecutor)).toBe(false);
    } finally {
      await installLegacyCompetitionGetFacade(sqlExecutor);
    }
  });

  it('does not treat partial DDL installation as completed retirement', async () => {
    try {
      await sqlExecutor.execute(
        `drop view \`${legacyGetView(DROP_REAL_VOTE_IN_TIME_TABLE)}\``
      );
      expect(await isCompetitionRuntimeRetired(sqlExecutor)).toBe(false);
    } finally {
      await installLegacyCompetitionGetFacade(sqlExecutor);
    }
  });
});
