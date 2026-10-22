import { getMetadataArgsStorage } from 'typeorm';
import * as registered from '@/entities/entities';
import { WaveBase, WaveEntity, WaveArchiveEntity } from '@/entities/IWave';
import { CompetitionEntity } from '@/entities/ICompetition';
import {
  assertCompetitionSchemaSyncSafe,
  RETIRED_COMPETITION_COLUMNS,
  RETIRED_COMPETITION_TABLES
} from './retired-competition-storage';

it('registers no retired tables or physical competition columns', () => {
  const registry = new Set(Object.values(registered));
  const metadata = getMetadataArgsStorage();
  expect(
    metadata.tables
      .filter(({ target }) => registry.has(target as never))
      .map(({ name }) => name)
      .filter((name) => RETIRED_COMPETITION_TABLES.includes(name as never))
  ).toEqual([]);
  for (const [table, targets] of [
    ['waves', [WaveBase, WaveEntity]],
    ['waves_archive', [WaveBase, WaveArchiveEntity]],
    ['competitions', [CompetitionEntity]]
  ] as const) {
    const columns = metadata.columns
      .filter(({ target }) => targets.includes(target as never))
      .map(({ propertyName }) => propertyName);
    expect(
      columns.filter((name) =>
        RETIRED_COMPETITION_COLUMNS[table].includes(name)
      )
    ).toEqual([]);
  }
});

it.each(
  Object.entries(RETIRED_COMPETITION_COLUMNS).flatMap(([table_name, columns]) =>
    columns.map((column_name) => ({ table_name, column_name }))
  )
)(
  'blocks incidental synchronization while $table_name.$column_name still exists',
  async (column) => {
    const execute = jest.fn().mockResolvedValue([column]);
    await expect(
      assertCompetitionSchemaSyncSafe({ execute } as never)
    ).rejects.toThrow('explicit backed-up operator cleanup');
  }
);

it('permits fresh and explicitly cleaned schemas without requiring retired source relations', async () => {
  const execute = jest.fn().mockResolvedValue([
    { table_name: 'waves', column_name: 'hub_voting_config' },
    { table_name: 'waves_archive', column_name: 'hub_participation_config' },
    { table_name: 'competitions', column_name: 'legacy_wave_id' }
  ]);
  await expect(
    assertCompetitionSchemaSyncSafe({ execute } as never)
  ).resolves.toBeUndefined();
  expect(execute).toHaveBeenCalledTimes(1);
});
