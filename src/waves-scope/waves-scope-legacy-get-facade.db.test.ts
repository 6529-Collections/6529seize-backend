import 'reflect-metadata';
import { wavesApiDb } from '@/api/waves/waves.api.db';
import { wavesMappers } from '@/api/waves/waves.mappers';
import {
  isLegacyCompetitionGetFacadeScope,
  withLegacyCompetitionGetFacade
} from '@/competitions/legacy-competition-get-facade';
import { DROPS_TABLE } from '@/constants';
import { DropType } from '@/entities/IDrop';
import { dbSupplier } from '@/sql-executor';
import { describeWithSeed } from '@/tests/_setup/seed';
import { aWave, withWaves } from '@/tests/fixtures/wave.fixture';
import {
  WavesScopeService,
  wavesScopeService
} from '@/waves-scope/waves-scope.service';

/**
 * Every non-v3 GET runs under the legacy competition GET facade, where a
 * SELECT's `waves` and `drops` read the legacy_get_* views. The scope rule
 * reads columns those views don't have (the hub configurations), so its
 * reads must run outside the facade: a GET's stays_on_site, on a cache
 * miss, failed with ER_BAD_FIELD_ERROR.
 */

const NO_CACHE = { readyCacheMs: 0, notReadyCacheMs: 0 };

const PUBLIC = aWave({}, { id: 'lgf-public', serial_no: 1, name: 'Public' });
const MENTIONED = aWave(
  {},
  { id: 'lgf-mentioned', serial_no: 2, name: 'Mentioned' }
);
const DM = aWave(
  { is_direct_message: true },
  { id: 'lgf-dm', serial_no: 3, name: 'Direct message' }
);
const POLL_WAVE = aWave({}, { id: 'lgf-poll', serial_no: 4, name: 'Poll' });

const aDropRow = (id: string, waveId: string, serialNo: number) => ({
  id,
  serial_no: serialNo,
  wave_id: waveId,
  author_id: 'lgf-author',
  created_at: serialNo,
  title: null,
  parts_count: 1,
  drop_type: DropType.CHAT,
  reply_to_drop_id: null
});

describeWithSeed(
  'the waves scope under the legacy competition GET facade',
  [
    withWaves([PUBLIC, MENTIONED, DM, POLL_WAVE]),
    {
      table: DROPS_TABLE,
      rows: [
        // The mapped wave's description drop.
        aDropRow(PUBLIC.description_drop_id, PUBLIC.id, 9000),
        aDropRow('lgf-poll-drop', POLL_WAVE.id, 9001),
        aDropRow('lgf-mention-drop', PUBLIC.id, 9002)
      ]
    }
  ],
  () => {
    const ids = [PUBLIC.id, MENTIONED.id, DM.id, POLL_WAVE.id];

    it('maps a wave through the waves mapper, its stays_on_site read on a cache miss', async () => {
      const [wave] = await withLegacyCompetitionGetFacade(async () => {
        expect(isLegacyCompetitionGetFacadeScope()).toBe(true);
        // As GET /waves/{id} reads it.
        const entity = await wavesApiDb.findWaveById(PUBLIC.id);
        return wavesMappers.waveEntitiesToApiWaves(
          {
            waveEntities: [entity!],
            groupIdsUserIsEligibleFor: [],
            noRightToVote: true,
            noRightToParticipate: true
          },
          {}
        );
      });
      expect(wave.id).toBe(PUBLIC.id);
      expect(typeof wave.stays_on_site).toBe('boolean');
    });

    it("reads stays_on_site for a poll drop's wave and a mentioned wave as the drops mappers do, the same as outside the facade", async () => {
      const outside = await new WavesScopeService(
        dbSupplier,
        () => false,
        NO_CACHE
      ).staysForDisplay(ids, {});
      // The shared service, on a cache miss, as the drops mappers call it:
      // a drop's wave, then the waves a drop mentions.
      const drops = await withLegacyCompetitionGetFacade(() =>
        wavesScopeService.staysForDisplay([POLL_WAVE.id], {})
      );
      const mentioned = await withLegacyCompetitionGetFacade(() =>
        wavesScopeService.staysForDisplay([MENTIONED.id, DM.id], {})
      );
      expect(drops.get(POLL_WAVE.id)).toBe(outside.get(POLL_WAVE.id));
      expect(mentioned.get(MENTIONED.id)).toBe(outside.get(MENTIONED.id));
      expect(mentioned.get(DM.id)).toBe(true);
    });

    it("runs every one of the service's reads", async () => {
      const service = new WavesScopeService(dbSupplier, () => false, NO_CACHE);
      const inside = await withLegacyCompetitionGetFacade(async () => ({
        scopes: await service.waveScopes(ids, {}, { replica: true }),
        stays: await service.waveStays(DM.id, {}),
        moving: await service.movingWaveIds(ids, {}),
        dropWave: await service.dropWaveId('lgf-poll-drop', {}),
        decisions: await service.decisionRefs(['lgf-no-such-decision'], {}),
        usedByMoving: await service.usedByMovingWave(['lgf-no-such-group'], {})
      }));
      const outside = await service.waveScopes(ids, {});
      expect(inside.scopes).toEqual(outside);
      expect(inside.stays).toBe(true);
      expect(inside.moving).toEqual(
        new Set(ids.filter((id) => !outside.get(id)?.stays))
      );
      expect(inside.dropWave).toBe(POLL_WAVE.id);
      expect(inside.decisions.size).toBe(0);
      expect(inside.usedByMoving).toBe(false);
    });
  }
);
