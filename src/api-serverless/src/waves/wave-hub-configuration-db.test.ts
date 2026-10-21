import {
  RETIRED_WAVE_COMPETITION_COLUMNS,
  legacyCompetitionGetSql,
  withLegacyCompetitionGetFacade,
  isLegacyCompetitionGetFacadeScope
} from '@/competitions/legacy-competition-get-facade';
import { WAVES_ARCHIVE_TABLE, WAVES_TABLE } from '@/constants';
import { SqlExecutor } from '@/sql-executor';
import { aWave } from '@/tests/fixtures/wave.fixture';
import { WavesApiDb, InsertWaveEntity } from './waves.api.db';

describe('native hub policy SQL boundary', () => {
  const entity: InsertWaveEntity = {
    ...aWave(
      { participation_terms: 'Shared terms', participation_group_id: 'role' },
      { id: 'native-hub', serial_no: 7, name: 'Hub' }
    ),
    participation_required_metadata: [],
    participation_required_media: [],
    is_direct_message: false,
    voting_credit_nfts: []
  };

  it('writes only shared fields and typed policies to the wave and its archive', async () => {
    const execute = jest.fn().mockResolvedValue([]);
    const repo = new WavesApiDb(() => ({ execute }) as unknown as SqlExecutor);
    const connection = { connection: {} };
    await repo.insertWave(entity, { connection });
    expect(execute).toHaveBeenCalledTimes(2);
    for (const [sql, parameters, options] of execute.mock.calls) {
      expect(sql).toMatch(
        new RegExp(`insert into (${WAVES_TABLE}|${WAVES_ARCHIVE_TABLE})`)
      );
      const columns = sql.match(/\(([^)]+)\)/)![1].split(',');
      for (const column of RETIRED_WAVE_COMPETITION_COLUMNS)
        expect(columns).not.toContain(column);
      expect(columns).toEqual(
        expect.arrayContaining([
          'hub_participation_config',
          'hub_voting_config'
        ])
      );
      expect(JSON.parse(parameters.hub_participation_config)).toMatchObject({
        group_id: 'role',
        terms: 'Shared terms',
        required_metadata: []
      });
      expect(JSON.parse(parameters.hub_voting_config)).toMatchObject({
        credit_type: 'TDH',
        group_id: null
      });
      expect(options).toEqual({ wrappedConnection: connection });
    }
    expect(execute.mock.calls[1][1].hub_participation_config).toBe(
      execute.mock.calls[0][1].hub_participation_config
    );
  });

  it.each([null, { group_id: 'independent-role', terms: 'Hub terms' }])(
    'preserves original-primary hub policy %p without copying projected competition rules',
    async (participation) => {
      const execute = jest.fn().mockResolvedValue([]);
      const repo = new WavesApiDb(
        () => ({ execute }) as unknown as SqlExecutor
      );
      const policy = {
        hub_participation_config: participation,
        hub_voting_config: null
      };
      await repo.insertWave(
        entity,
        { connection: { connection: {} } },
        {
          preserveHubConfigurationFrom: policy as never
        }
      );
      for (const [, parameters] of execute.mock.calls) {
        expect(parameters.hub_participation_config).toBe(
          participation === null ? null : JSON.stringify(participation)
        );
        expect(parameters.hub_voting_config).toBeNull();
      }
    }
  );

  it('locks only the stored native policy columns and parses them once inside a public GET scope', async () => {
    const oneOrNull = jest.fn(async (sql: string) => {
      expect(legacyCompetitionGetSql(sql)).toBe(sql);
      expect(sql).toBe(
        `select hub_participation_config,hub_voting_config from ${WAVES_TABLE} where id=:waveId for update`
      );
      return {
        hub_participation_config: JSON.stringify({
          group_id: null,
          terms: 'null'
        }),
        hub_voting_config: null
      };
    });
    const repo = new WavesApiDb(
      () => ({ oneOrNull }) as unknown as SqlExecutor
    );
    const connection = { connection: {} };
    await withLegacyCompetitionGetFacade(async () => {
      expect(
        await repo.findWaveHubConfigurationForUpdate(entity.id, { connection })
      ).toEqual({
        hub_participation_config: { group_id: null, terms: 'null' },
        hub_voting_config: null
      });
      expect(isLegacyCompetitionGetFacadeScope()).toBe(true);
    });
    expect(oneOrNull).toHaveBeenCalledWith(
      expect.any(String),
      { waveId: entity.id },
      { wrappedConnection: connection }
    );
  });
});
