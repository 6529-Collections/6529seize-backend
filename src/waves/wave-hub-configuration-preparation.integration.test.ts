import * as tables from '@/constants';
import { createHash } from 'node:crypto';
import { sqlExecutor } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import {
  ParticipationRequiredMedia,
  WaveCreditType,
  WaveEntity,
  WaveRequiredMetadataItemType,
  WaveType
} from '@/entities/IWave';
import { WavesMappers } from '@/api/waves/waves.mappers';
import { WavesApiDb } from '@/api/waves/waves.api.db';
import { UpdateWaveSchema } from '@/api/waves/wave-write.schemas';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { ApiWaveCreditType } from '@/api/generated/models/ApiWaveCreditType';
import { ApiWaveType } from '@/api/generated/models/ApiWaveType';
import { waveHubConfigurationFromWave } from './wave-hub-configuration';
import {
  installLegacyCompetitionGetFacade,
  legacyGetView
} from '@/competitions/legacy-competition-get-facade';
import {
  frozenNativeGetView,
  FROZEN_NATIVE_GET_TABLES,
  installFrozenNativeGetProjections
} from '@/competitions/contract-fixtures/origin-main-native-get-projections.fixture';
import {
  prepareWaveHubConfiguration,
  assertWaveHubConfigurationParity,
  finalizeWaveHubConfigurationCapture
} from './wave-hub-configuration-preparation';

const old = aWave(
  {
    type: WaveType.CHAT,
    voting_credit_type: WaveCreditType.TDH_PLUS_XTDH,
    visibility_group_id: 'visible',
    participation_group_id: 'independent-participants',
    voting_group_id: 'independent-voters',
    voting_credit_category: 'null',
    participation_terms: 'null',
    voting_period_start: 1712345678901,
    participation_period_start: 1712345678900,
    time_lock_ms: 300000,
    participation_max_applications_per_participant: 0,
    participation_required_metadata: [
      { name: 'Answer', type: WaveRequiredMetadataItemType.STRING }
    ],
    participation_required_media: [ParticipationRequiredMedia.IMAGE],
    forbid_negative_votes: false,
    hub_participation_config: null,
    hub_voting_config: null
  },
  { id: 'z-shared-hub', name: 'Shared hub', serial_no: 1 }
);
const second = aWave(
  {
    type: WaveType.CHAT,
    is_direct_message: true,
    visibility_group_id: 'dm-members',
    participation_group_id: 'dm-members',
    chat_group_id: 'dm-members',
    participation_terms: '',
    hub_participation_config: null,
    hub_voting_config: null
  },
  { id: 'y-direct-message', name: 'DM', serial_no: 2 }
);

async function livePolicy(id: string) {
  const row = await sqlExecutor.oneOrNull<{
    participation: string;
    voting: string;
  }>(
    `SELECT hub_participation_config AS participation,hub_voting_config AS voting FROM ${tables.WAVES_TABLE} WHERE id=:id`,
    { id }
  );
  return {
    participation: JSON.parse(row!.participation),
    voting: JSON.parse(row!.voting)
  };
}

describeWithSeed(
  'live shared-hub policy preparation during rolling writers',
  [withWaves([old, second])],
  () => {
    beforeEach(async () => {
      // The deployed preparation facade still reads the physical source. A
      // native-only facade is installed only after the explicit preparation.
      await sqlExecutor.execute(
        `CREATE OR REPLACE VIEW ${legacyGetView(tables.WAVES_TABLE)} AS SELECT * FROM ${tables.WAVES_TABLE}`
      );
    });
    afterEach(async () => {
      await installLegacyCompetitionGetFacade(sqlExecutor);
      await sqlExecutor.execute(
        'DROP TRIGGER IF EXISTS temporary_wave_hub_configuration_unrecognized'
      );
      await finalizeWaveHubConfigurationCapture(sqlExecutor);
      for (const table of FROZEN_NATIVE_GET_TABLES)
        await sqlExecutor.execute(
          `DROP VIEW IF EXISTS ${frozenNativeGetView(table)}`
        );
    });

    it('preserves JSON null decision strategies through Chat and DM preparation and native reads', async () => {
      const waves = [old, second];
      const repository = new WavesApiDb(() => sqlExecutor);
      await sqlExecutor.execute(
        `UPDATE ${tables.WAVES_TABLE} SET decisions_strategy=CAST('null' AS JSON) WHERE id IN (:ids)`,
        { ids: waves.map((wave) => wave.id) }
      );
      const archives = waves.map((wave, index) => ({
        ...wave,
        archive_id: index + 101,
        archival_entry_created_at: 1800000000000,
        decisions_strategy: 'null'
      }));
      await sqlExecutor.bulkInsert(
        tables.WAVES_ARCHIVE_TABLE,
        archives,
        Object.keys(archives[0]).filter(
          (field) => !field.startsWith('hub_') && field !== 'next_decision_time'
        ),
        {}
      );
      for (const wave of waves)
        expect(
          (await repository.findWaveById(wave.id))?.decisions_strategy
        ).toBeNull();

      expect(await prepareWaveHubConfiguration(sqlExecutor)).toEqual({
        waves: 2,
        archives: 2,
        capture_triggers: 14
      });
      await installLegacyCompetitionGetFacade(sqlExecutor);
      for (const wave of waves)
        expect(
          (await repository.findWaveById(wave.id))?.decisions_strategy
        ).toBeNull();
      for (const table of [tables.WAVES_TABLE, tables.WAVES_ARCHIVE_TABLE])
        expect(
          await sqlExecutor.execute(
            `SELECT JSON_TYPE(decisions_strategy) AS kind,decisions_strategy IS NULL AS sql_null FROM ${table} ORDER BY id`
          )
        ).toEqual([
          { kind: 'NULL', sql_null: 0 },
          { kind: 'NULL', sql_null: 0 }
        ]);
    });

    it('retains typed Chat and DM strategy values and their archive snapshots through native preparation', async () => {
      await prepareWaveHubConfiguration(sqlExecutor);
      const previousCaptures = await sqlExecutor.execute<{
        name: string;
        body: string;
      }>(
        "SELECT TRIGGER_NAME AS name,ACTION_STATEMENT AS body FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=database() AND TRIGGER_NAME LIKE 'temporary_wave_hub_configuration_%' AND TRIGGER_NAME NOT LIKE 'temporary_wave_hub_configuration_strategy_%' ORDER BY TRIGGER_NAME"
      );
      expect(previousCaptures).toHaveLength(10);
      // Recorded against the actually deployed predecessor before this fix.
      expect(
        createHash('sha256')
          .update(
            JSON.stringify(
              previousCaptures.map((row) => ({
                ...row,
                body: row.body.replace(/\s+/g, ' ').trim()
              }))
            )
          )
          .digest('hex')
      ).toBe(
        'b341562030dc77438c3ce485a62b0b0bcfb11c3b3f17602dd7f2141ece8e7e47'
      );
      const overlays = await sqlExecutor.execute<{ name: string }>(
        "SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=database() AND TRIGGER_NAME LIKE 'temporary_wave_hub_configuration_strategy_%'"
      );
      for (const overlay of overlays)
        await sqlExecutor.execute(`DROP TRIGGER \`${overlay.name}\``);
      await sqlExecutor.execute(
        `UPDATE ${tables.WAVES_TABLE} SET hub_voting_config=JSON_REMOVE(hub_voting_config,'$.decision_strategy')`
      );
      const strategy = {
        first_decision_time: 1712345678999,
        subsequent_decisions: [12345, 67890],
        is_rolling: true
      };
      const repository = new WavesApiDb(() => sqlExecutor);
      await sqlExecutor.execute(
        `UPDATE ${tables.WAVES_TABLE} SET decisions_strategy=CAST(:strategy AS JSON)`,
        { strategy: JSON.stringify(strategy) }
      );
      const archives = [old, second].map((wave, index) => ({
        ...wave,
        archive_id: index + 201,
        archival_entry_created_at: 1800000000000,
        decisions_strategy: JSON.stringify(strategy)
      }));
      await sqlExecutor.bulkInsert(
        tables.WAVES_ARCHIVE_TABLE,
        archives,
        Object.keys(archives[0]).filter(
          (field) => !field.startsWith('hub_') && field !== 'next_decision_time'
        ),
        {}
      );
      for (const wave of [old, second])
        expect(
          (await repository.findWaveById(wave.id))?.decisions_strategy
        ).toEqual(strategy);
      await prepareWaveHubConfiguration(sqlExecutor);
      for (const wave of [old, second])
        expect((await livePolicy(wave.id)).voting.decision_strategy).toEqual(
          strategy
        );
      const snapshots = await sqlExecutor.execute<{
        policy: string;
        source: string;
      }>(
        `SELECT hub_voting_config AS policy,decisions_strategy AS source FROM ${tables.WAVES_ARCHIVE_TABLE} ORDER BY archive_id`
      );
      for (const snapshot of snapshots) {
        expect(JSON.parse(snapshot.policy).decision_strategy).toEqual(strategy);
        expect(JSON.parse(snapshot.source)).toEqual(strategy);
      }
      await installLegacyCompetitionGetFacade(sqlExecutor);
      for (const wave of [old, second])
        expect(
          (await repository.findWaveById(wave.id))?.decisions_strategy
        ).toEqual(strategy);
    });

    it.each([
      '{}',
      '[]',
      '"null"',
      '{"first_decision_time":1,"subsequent_decisions":["not-an-integer"],"is_rolling":true}',
      '{"first_decision_time":1,"subsequent_decisions":[],"is_rolling":true,"extra":1}'
    ])('still rejects non-null Chat decision strategy %s', async (strategy) => {
      await sqlExecutor.execute(
        `UPDATE ${tables.WAVES_TABLE} SET decisions_strategy=CAST(:strategy AS JSON) WHERE id=:id`,
        { strategy, id: old.id }
      );
      await expect(prepareWaveHubConfiguration(sqlExecutor)).rejects.toThrow(
        '"field":"decisions_strategy","count":1'
      );
    });

    it.each([
      {
        label: 'public strategy object',
        strategy: {
          first_decision_time: 1712345678999,
          subsequent_decisions: [987654321],
          is_rolling: true
        },
        expected: {
          source_json_type: 'OBJECT',
          first_decision_time_type: 'UNSIGNED INTEGER',
          subsequent_decisions_type: 'ARRAY',
          is_rolling_type: 'BOOLEAN',
          property_count: 3,
          encoded_null_rows: 0
        }
      },
      {
        label: 'encoded null string',
        strategy: 'null',
        expected: {
          source_json_type: 'STRING',
          first_decision_time_type: null,
          subsequent_decisions_type: null,
          is_rolling_type: null,
          property_count: 1,
          encoded_null_rows: 1
        }
      }
    ])(
      'reports only aggregate strategy shape for $label',
      async ({ strategy, expected }) => {
        await sqlExecutor.execute(
          `UPDATE ${tables.WAVES_TABLE} SET decisions_strategy=CAST(:strategy AS JSON) WHERE id=:id`,
          { strategy: JSON.stringify(strategy), id: old.id }
        );
        const repository = new WavesApiDb(() => sqlExecutor);
        expect(
          (await repository.findWaveById(old.id))?.decisions_strategy
        ).toEqual(strategy);
        // An existing explicit native value is never overwritten by preparation.
        await sqlExecutor.execute(
          `UPDATE ${tables.WAVES_TABLE} SET hub_voting_config=:policy WHERE id=:id`,
          {
            id: old.id,
            policy: JSON.stringify({
              ...waveHubConfigurationFromWave(old).voting,
              decision_strategy: null
            })
          }
        );
        const message = await prepareWaveHubConfiguration(sqlExecutor).then(
          () => {
            throw new Error('Expected non-null strategy parity rejection');
          },
          (error: unknown) => {
            if (!(error instanceof Error)) throw error;
            return error.message;
          }
        );
        const prefix = 'strategy_shapes=';
        expect(message).toContain(prefix);
        expect(
          JSON.parse(message.slice(message.indexOf(prefix) + prefix.length))
        ).toEqual([
          {
            table: tables.WAVES_TABLE,
            is_direct_message: 0,
            ...expected,
            count: 1
          }
        ]);
        expect(message).not.toContain(old.id);
        expect(message).not.toContain('1712345678999');
        expect(message).not.toContain('987654321');
      }
    );

    it('preserves and clears strategies across old and native writers, rejecting new malformed writes atomically', async () => {
      const strategy = {
        first_decision_time: 1712345678999,
        subsequent_decisions: [3600000],
        is_rolling: false
      };
      await sqlExecutor.execute(
        `UPDATE ${tables.WAVES_TABLE} SET decisions_strategy=CAST(:strategy AS JSON) WHERE id=:id`,
        { id: old.id, strategy: JSON.stringify(strategy) }
      );
      await prepareWaveHubConfiguration(sqlExecutor);
      // The original parent capture replaces its policy from changed old fields.
      // The ordered overlay must preserve the separately owned strategy member.
      await sqlExecutor.execute(
        `UPDATE ${tables.WAVES_TABLE} SET voting_period_end=1712349999999 WHERE id=:id`,
        { id: old.id }
      );
      expect((await livePolicy(old.id)).voting.decision_strategy).toEqual(
        strategy
      );
      await sqlExecutor.execute(
        `UPDATE ${tables.WAVES_TABLE} SET hub_voting_config=JSON_SET(hub_voting_config,'$.decision_strategy',CAST('null' AS JSON)) WHERE id=:id`,
        { id: old.id }
      );
      expect(
        await sqlExecutor.oneOrNull(
          `SELECT decisions_strategy FROM ${tables.WAVES_TABLE} WHERE id=:id`,
          { id: old.id }
        )
      ).toEqual({ decisions_strategy: null });
      await sqlExecutor.execute(
        `UPDATE ${tables.WAVES_TABLE} SET decisions_strategy=CAST(:strategy AS JSON) WHERE id=:id`,
        { id: old.id, strategy: JSON.stringify(strategy) }
      );
      await expect(
        sqlExecutor.execute(
          `UPDATE ${tables.WAVES_TABLE} SET decisions_strategy=CAST('"null"' AS JSON) WHERE id=:id`,
          { id: old.id }
        )
      ).rejects.toThrow(
        'Shared hub decision strategy has an unsupported shape'
      );
      await expect(
        sqlExecutor.execute(
          `UPDATE ${tables.WAVES_TABLE} SET hub_voting_config=JSON_SET(hub_voting_config,'$.decision_strategy',JSON_ARRAY()) WHERE id=:id`,
          { id: old.id }
        )
      ).rejects.toThrow(
        'Native hub decision strategy has an unsupported shape'
      );
      expect((await livePolicy(old.id)).voting.decision_strategy).toEqual(
        strategy
      );
      expect(
        JSON.parse(
          (await sqlExecutor.oneOrNull<{ strategy: string }>(
            `SELECT decisions_strategy AS strategy FROM ${tables.WAVES_TABLE} WHERE id=:id`,
            { id: old.id }
          ))!.strategy
        )
      ).toEqual(strategy);
      expect(await assertWaveHubConfigurationParity(sqlExecutor)).toEqual({
        waves: 2,
        archives: 0
      });
      await sqlExecutor.execute(
        `UPDATE ${tables.WAVES_TABLE} SET decisions_strategy=NULL WHERE id=:id`,
        { id: old.id }
      );
      expect((await livePolicy(old.id)).voting.decision_strategy).toBeNull();
    });

    it('treats missing additive strategies as null after retirement and validates only current typed values', async () => {
      await prepareWaveHubConfiguration(sqlExecutor);
      await installLegacyCompetitionGetFacade(sqlExecutor);
      await finalizeWaveHubConfigurationCapture(sqlExecutor);
      await sqlExecutor.execute(
        `UPDATE ${tables.WAVES_TABLE} SET hub_voting_config=JSON_REMOVE(hub_voting_config,'$.decision_strategy'),decisions_strategy=JSON_OBJECT('obsolete','ignored') WHERE id=:id`,
        { id: old.id }
      );
      expect(
        (await new WavesApiDb(() => sqlExecutor).findWaveById(old.id))
          ?.decisions_strategy
      ).toBeNull();
      expect(await finalizeWaveHubConfigurationCapture(sqlExecutor)).toEqual({
        disabled_triggers: 0
      });
      await sqlExecutor.execute(
        `UPDATE ${tables.WAVES_TABLE} SET hub_voting_config=JSON_SET(hub_voting_config,'$.decision_strategy',JSON_ARRAY()) WHERE id=:id`,
        { id: old.id }
      );
      try {
        await expect(
          finalizeWaveHubConfigurationCapture(sqlExecutor)
        ).rejects.toThrow(
          '"field":"hub_voting_config.decision_strategy","count":1'
        );
      } finally {
        await sqlExecutor.execute(
          `UPDATE ${tables.WAVES_TABLE} SET hub_voting_config=JSON_REMOVE(hub_voting_config,'$.decision_strategy') WHERE id=:id`,
          { id: old.id }
        );
      }
      await expect(prepareWaveHubConfiguration(sqlExecutor)).rejects.toThrow(
        'no longer permitted'
      );
    });

    it('captures old parent/child writes behind bounded cursors, retains each archive ID, and matches full frozen CHAT/DM projection primitives', async () => {
      const batches: number[] = [];
      let inserted = false;
      const result = await prepareWaveHubConfiguration(sqlExecutor, {
        batchSize: 1,
        onBatch: async (batch) => {
          batches.push(batch.rows);
          if (batch.table !== tables.WAVES_TABLE || inserted) return;
          inserted = true;
          await sqlExecutor.executeNativeQueriesInTransaction(
            async (connection) => {
              const ctx = { connection };
              const behind = {
                ...old,
                id: 'a-new-old-api-hub',
                serial_no: 3,
                participation_terms: 'Résumé 二'
              };
              const fields = Object.keys(behind).filter(
                (field) => !field.startsWith('hub_')
              );
              await sqlExecutor.bulkInsert(
                tables.WAVES_TABLE,
                [behind],
                fields,
                ctx
              );
              await sqlExecutor.execute(
                `UPDATE ${tables.WAVES_TABLE} SET participation_terms='old writer edit',voting_period_end=1712345679999 WHERE id=:id`,
                { id: second.id },
                { wrappedConnection: connection }
              );
              const archive = {
                ...behind,
                archive_id: 17,
                archival_entry_created_at: 1800000000000
              };
              const archiveFields = Object.keys(archive).filter(
                (field) =>
                  !field.startsWith('hub_') && field !== 'next_decision_time'
              );
              await sqlExecutor.bulkInsert(
                tables.WAVES_ARCHIVE_TABLE,
                [archive],
                archiveFields,
                ctx
              );
              await sqlExecutor.execute(
                `INSERT INTO ${tables.WAVE_VOTING_CREDIT_NFTS_TABLE}(wave_id,contract,token_id) VALUES(:id,'0xBb',2),(:id,'0xAa',1)`,
                { id: behind.id },
                { wrappedConnection: connection }
              );
              await sqlExecutor.execute(
                `INSERT INTO ${tables.WAVE_VOTING_CREDIT_NFTS_ARCHIVE_TABLE}(wave_archive_id,wave_id,contract,token_id) VALUES(17,:id,'0xCc',3)`,
                { id: behind.id },
                { wrappedConnection: connection }
              );
            }
          );
        }
      });
      expect(result).toEqual({ waves: 3, archives: 1, capture_triggers: 14 });
      expect(batches.every((rows) => rows === 1)).toBe(true);
      expect(await livePolicy('a-new-old-api-hub')).toMatchObject({
        participation: { terms: 'Résumé 二' },
        voting: {
          credit_nfts: [
            { contract: '0xAa', token_id: 1 },
            { contract: '0xBb', token_id: 2 }
          ]
        }
      });
      const archive = await sqlExecutor.oneOrNull<{ voting: string }>(
        `SELECT hub_voting_config AS voting FROM ${tables.WAVES_ARCHIVE_TABLE} WHERE archive_id=17`
      );
      expect(JSON.parse(archive!.voting).credit_nfts).toEqual([
        { contract: '0xCc', token_id: 3 }
      ]);
      await sqlExecutor.execute(
        `UPDATE ${tables.WAVE_VOTING_CREDIT_NFTS_TABLE} SET token_id=4 WHERE wave_id=:id AND token_id=2`,
        { id: 'a-new-old-api-hub' }
      );
      await sqlExecutor.execute(
        `DELETE FROM ${tables.WAVE_VOTING_CREDIT_NFTS_TABLE} WHERE wave_id=:id AND token_id=1`,
        { id: 'a-new-old-api-hub' }
      );
      await sqlExecutor.execute(
        `DELETE FROM ${tables.WAVE_VOTING_CREDIT_NFTS_ARCHIVE_TABLE} WHERE wave_archive_id=17`
      );
      expect(
        (await livePolicy('a-new-old-api-hub')).voting.credit_nfts
      ).toEqual([{ contract: '0xBb', token_id: 4 }]);
      const archiveAfter = await sqlExecutor.oneOrNull<{ voting: string }>(
        `SELECT hub_voting_config AS voting FROM ${tables.WAVES_ARCHIVE_TABLE} WHERE archive_id=17`
      );
      expect(JSON.parse(archiveAfter!.voting).credit_nfts).toEqual([]);
      expect(
        await prepareWaveHubConfiguration(sqlExecutor, { batchSize: 1 })
      ).toEqual(result);
      await installFrozenNativeGetProjections(sqlExecutor);
      // The two additive native fields were not columns in the frozen public
      // projection. Compare every original column, rather than alter its fixture.
      const metadata = await sqlExecutor.execute<{ name: string }>(
        `SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=database() AND TABLE_NAME=:view ORDER BY ORDINAL_POSITION`,
        { view: frozenNativeGetView(tables.WAVES_TABLE) }
      );
      const columns = metadata
        .map((row) => row.name)
        .filter((name) => !name.startsWith('hub_'))
        .map((name) => '`' + name + '`')
        .join(',');
      const baseline = await sqlExecutor.execute(
        `SELECT ${columns} FROM ${frozenNativeGetView(tables.WAVES_TABLE)} ORDER BY id`
      );
      const nfts = await sqlExecutor.execute(
        `SELECT * FROM ${frozenNativeGetView(tables.WAVE_VOTING_CREDIT_NFTS_TABLE)} ORDER BY wave_id,contract,token_id`
      );
      await installLegacyCompetitionGetFacade(sqlExecutor);
      expect(
        await sqlExecutor.execute(
          `SELECT ${columns} FROM ${legacyGetView(tables.WAVES_TABLE)} ORDER BY id`
        )
      ).toEqual(baseline);
      expect(
        await sqlExecutor.execute(
          `SELECT * FROM ${legacyGetView(tables.WAVE_VOTING_CREDIT_NFTS_TABLE)} ORDER BY wave_id,contract,token_id`
        )
      ).toEqual(nfts);
      expect(
        await sqlExecutor.oneOrNull(
          `SELECT participation_terms,voting_credit_category,participation_max_applications_per_participant,participation_signature_required FROM ${legacyGetView(tables.WAVES_TABLE)} WHERE id=:id`,
          { id: old.id }
        )
      ).toEqual({
        participation_terms: 'null',
        voting_credit_category: 'null',
        participation_max_applications_per_participant: 0,
        participation_signature_required: 0
      });
      const filter = (view: string) =>
        sqlExecutor.execute(
          `SELECT id,participation_terms FROM ${view} WHERE participation_terms='resume 二' ORDER BY participation_terms,id`
        );
      const matched = await filter(frozenNativeGetView(tables.WAVES_TABLE));
      expect(matched).toEqual([
        { id: 'a-new-old-api-hub', participation_terms: 'Résumé 二' }
      ]);
      expect(await filter(legacyGetView(tables.WAVES_TABLE))).toEqual(matched);
    });

    it('preserves explicit native policy writes and emits only field/count diagnostics for contradictory source parity', async () => {
      await sqlExecutor.execute(
        `UPDATE ${tables.WAVES_TABLE} SET hub_participation_config=:policy WHERE id=:id`,
        {
          id: old.id,
          policy: JSON.stringify({
            ...waveHubConfigurationFromWave(old).participation,
            terms: 'private-native-value'
          })
        }
      );
      expect((await livePolicy(old.id)).participation.terms).toBe(
        'private-native-value'
      );
      const error = await prepareWaveHubConfiguration(sqlExecutor).catch(
        (cause) => cause as Error
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        '"field":"participation_terms","count":1'
      );
      expect((error as Error).message).not.toContain(old.id);
      expect((error as Error).message).not.toContain('private-native-value');
      await expect(prepareWaveHubConfiguration(sqlExecutor)).rejects.toThrow(
        'Native shared-hub configuration parity failed'
      );
      expect((await livePolicy(old.id)).participation.terms).toBe(
        'private-native-value'
      );
      await installLegacyCompetitionGetFacade(sqlExecutor);
      expect(
        await sqlExecutor.oneOrNull(
          `SELECT participation_terms FROM ${legacyGetView(tables.WAVES_TABLE)} WHERE id=:id`,
          { id: old.id }
        )
      ).toEqual({ participation_terms: 'private-native-value' });
    });

    it('keeps old optional-field readers coherent after native policy writes throughout the rolling overlap', async () => {
      await prepareWaveHubConfiguration(sqlExecutor);
      await sqlExecutor.execute(
        `UPDATE ${tables.WAVES_TABLE} SET hub_voting_config=JSON_SET(hub_voting_config,
          '$.credit_scope','DROP','$.credit_type','REP','$.forbid_negative_votes',CAST('true' AS JSON)),
          hub_participation_config=JSON_SET(hub_participation_config,'$.terms','native accepted terms',
          '$.signature_required',CAST('true' AS JSON),'$.submission_type','IDENTITY',
          '$.identity_submission_strategy','EVERYONE','$.identity_submission_duplicates','ALWAYS_ALLOW') WHERE id=:id`,
        { id: old.id }
      );
      const before = await sqlExecutor.oneOrNull<WaveEntity>(
        `SELECT * FROM ${tables.WAVES_TABLE} WHERE id=:id`,
        { id: old.id }
      );
      expect(before).toMatchObject({
        voting_credit_scope: 'DROP',
        voting_credit_type: 'REP',
        participation_terms: 'native accepted terms',
        participation_signature_required: true,
        forbid_negative_votes: true,
        submission_type: 'IDENTITY',
        identity_submission_strategy: 'EVERYONE',
        identity_submission_duplicates: 'ALWAYS_ALLOW'
      });
      const request = getValidatedByJoiOrThrow(
        {
          name: 'Old API shared edit',
          picture: null,
          visibility: { scope: { group_id: before!.visibility_group_id } },
          chat: { scope: { group_id: before!.chat_group_id }, enabled: true },
          participation: {
            scope: { group_id: before!.participation_group_id },
            no_of_applications_allowed_per_participant: 0,
            required_metadata: JSON.parse(
              before!.participation_required_metadata as unknown as string
            ),
            required_media: JSON.parse(
              before!.participation_required_media as unknown as string
            ),
            signature_required: true,
            terms: before!.participation_terms,
            period: { min: before!.participation_period_start, max: null }
          },
          voting: {
            scope: { group_id: before!.voting_group_id },
            credit_type: ApiWaveCreditType.Rep,
            credit_category: before!.voting_credit_category,
            creditor_id: null,
            credit_nfts: null,
            signature_required: false,
            forbid_negative_votes: true,
            period: { min: before!.voting_period_start, max: null }
            // Deliberately omit credit_scope, as an already running PREP API does.
          },
          wave: {
            type: ApiWaveType.Chat,
            winning_threshold: null,
            max_winners: null,
            time_lock_ms: 300000,
            decisions_strategy: null,
            admin_group: { group_id: null },
            admin_drop_deletion_enabled: false
          }
        },
        UpdateWaveSchema
      );
      expect(request.voting.credit_scope).toBeUndefined();
      expect(request.participation.submission_strategy).toBeUndefined();
      const mapper = new WavesMappers(
        {} as never,
        {} as never,
        {} as never,
        {} as never
      );
      const mapped = await mapper.createWaveToNewWaveEntity({
        id: old.id,
        serial_no: old.serial_no,
        created_at: old.created_at,
        updated_at: 1800000000001,
        request,
        created_by: old.created_by,
        descriptionDropId: old.description_drop_id,
        nextDecisionTime: null,
        isDirectMessage: false,
        existingSubmissionStrategy: before!,
        existingWaveSettings: before!
      });
      expect(mapped.voting_credit_scope).toBe('DROP');
      expect(mapped).toMatchObject({
        submission_type: 'IDENTITY',
        identity_submission_strategy: 'EVERYONE',
        identity_submission_duplicates: 'ALWAYS_ALLOW'
      });
      await sqlExecutor.executeNativeQueriesInTransaction(
        async (connection) => {
          await sqlExecutor.execute(
            `DELETE FROM ${tables.WAVES_TABLE} WHERE id=:id`,
            { id: old.id },
            { wrappedConnection: connection }
          );
          const columns = Object.keys(mapped).filter(
            (column) =>
              column !== 'voting_credit_nfts' && !column.startsWith('hub_')
          );
          const raw = {
            ...mapped,
            participation_required_metadata: JSON.stringify(
              mapped.participation_required_metadata
            ),
            participation_required_media: JSON.stringify(
              mapped.participation_required_media
            )
          };
          await sqlExecutor.bulkInsert(tables.WAVES_TABLE, [raw], columns, {
            connection
          });
          const archive = {
            ...raw,
            archive_id: 19,
            archival_entry_created_at: 1800000000002
          };
          await sqlExecutor.bulkInsert(
            tables.WAVES_ARCHIVE_TABLE,
            [archive],
            [
              ...columns.filter((column) => column !== 'next_decision_time'),
              'archive_id',
              'archival_entry_created_at'
            ],
            { connection }
          );
        }
      );
      expect(await livePolicy(old.id)).toMatchObject({
        participation: {
          terms: 'native accepted terms',
          signature_required: true,
          submission_type: 'IDENTITY',
          identity_submission_strategy: 'EVERYONE',
          identity_submission_duplicates: 'ALWAYS_ALLOW'
        },
        voting: {
          credit_scope: 'DROP',
          credit_type: 'REP',
          forbid_negative_votes: true
        }
      });
      const archive = await sqlExecutor.oneOrNull<{ voting: string }>(
        `SELECT hub_voting_config AS voting FROM ${tables.WAVES_ARCHIVE_TABLE} WHERE archive_id=19`
      );
      expect(JSON.parse(archive!.voting).credit_scope).toBe('DROP');
      expect(await assertWaveHubConfigurationParity(sqlExecutor)).toEqual({
        waves: 2,
        archives: 1
      });
    });

    it('validates the entire temporary namespace, finalizes idempotently, and never imports sources after native cutover', async () => {
      await prepareWaveHubConfiguration(sqlExecutor);
      await expect(
        finalizeWaveHubConfigurationCapture(sqlExecutor)
      ).rejects.toThrow('Switch native competition views');
      await installLegacyCompetitionGetFacade(sqlExecutor);
      await sqlExecutor.execute(
        `UPDATE ${tables.WAVES_TABLE} SET hub_participation_config=JSON_REMOVE(hub_participation_config,'$.terms') WHERE id=:id`,
        { id: old.id }
      );
      await expect(
        finalizeWaveHubConfigurationCapture(sqlExecutor)
      ).rejects.toThrow('Native shared-hub configuration is incomplete');
      await sqlExecutor.execute(
        `UPDATE ${tables.WAVES_TABLE} SET hub_participation_config=JSON_SET(hub_participation_config,'$.terms','null') WHERE id=:id`,
        { id: old.id }
      );
      await sqlExecutor.execute(
        `CREATE TRIGGER temporary_wave_hub_configuration_unrecognized BEFORE INSERT ON ${tables.WAVES_TABLE} FOR EACH ROW SET NEW.name=NEW.name`
      );
      await expect(
        finalizeWaveHubConfigurationCapture(sqlExecutor)
      ).rejects.toThrow('Unrecognized temporary');
      const [{ count }] = await sqlExecutor.execute<{ count: number }>(
        "SELECT count(*) AS count FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=database() AND TRIGGER_NAME LIKE 'temporary_wave_hub_configuration_%'"
      );
      expect(Number(count)).toBe(15);
      await sqlExecutor.execute(
        'DROP TRIGGER temporary_wave_hub_configuration_unrecognized'
      );
      const captureName = 'temporary_wave_hub_configuration_wave_update';
      const original = await sqlExecutor.oneOrNull<{ body: string }>(
        `SELECT ACTION_STATEMENT AS body FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=database() AND TRIGGER_NAME=:name`,
        { name: captureName }
      );
      expect(original).not.toBeNull();
      await sqlExecutor.execute(`DROP TRIGGER ${captureName}`);
      await sqlExecutor.execute(
        `CREATE TRIGGER ${captureName} BEFORE UPDATE ON ${tables.WAVES_TABLE} FOR EACH ROW SET NEW.name=NEW.name`
      );
      try {
        await expect(
          finalizeWaveHubConfigurationCapture(sqlExecutor)
        ).rejects.toThrow('Unrecognized temporary');
        const [{ remaining }] = await sqlExecutor.execute<{
          remaining: number;
        }>(
          "SELECT count(*) AS remaining FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=database() AND TRIGGER_NAME LIKE 'temporary_wave_hub_configuration_%'"
        );
        expect(Number(remaining)).toBe(14);
      } finally {
        await sqlExecutor.execute(`DROP TRIGGER ${captureName}`);
        await sqlExecutor.execute(
          `CREATE TRIGGER ${captureName} BEFORE UPDATE ON ${tables.WAVES_TABLE} FOR EACH ROW PRECEDES temporary_wave_hub_configuration_strategy_wave_update ${original!.body}`
        );
      }
      expect(await finalizeWaveHubConfigurationCapture(sqlExecutor)).toEqual({
        disabled_triggers: 14
      });
      expect(await finalizeWaveHubConfigurationCapture(sqlExecutor)).toEqual({
        disabled_triggers: 0
      });
      await expect(prepareWaveHubConfiguration(sqlExecutor)).rejects.toThrow(
        'no longer permitted'
      );
      await sqlExecutor.execute(
        `UPDATE ${tables.WAVES_TABLE} SET hub_participation_config=JSON_SET(hub_participation_config,'$.terms','native final edit') WHERE id=:id`,
        { id: old.id }
      );
      expect(
        await sqlExecutor.oneOrNull(
          `SELECT participation_terms FROM ${legacyGetView(tables.WAVES_TABLE)} WHERE id=:id`,
          { id: old.id }
        )
      ).toEqual({ participation_terms: 'native final edit' });
    });
  }
);
