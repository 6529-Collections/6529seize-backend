import * as tables from '@/constants';
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
      expect(result).toEqual({ waves: 3, archives: 1, capture_triggers: 10 });
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
      expect(Number(count)).toBe(11);
      await sqlExecutor.execute(
        'DROP TRIGGER temporary_wave_hub_configuration_unrecognized'
      );
      expect(await finalizeWaveHubConfigurationCapture(sqlExecutor)).toEqual({
        disabled_triggers: 10
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
