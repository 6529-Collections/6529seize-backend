import { StayReason, WaveScope } from '@/waves-scope/waves-scope';
import { wavesScopeService } from '@/waves-scope/waves-scope.service';

/**
 * Stubs the waves scope lookups for unit tests that have no database. The
 * waves in `staying` stay on 6529.io and every other wave moves; a group in
 * `movingWaveGroups` is used by a moving wave. Returns the spies.
 */
export function stubWavesScope({
  staying = [],
  movingWaveGroups = []
}: {
  readonly staying?: readonly string[];
  readonly movingWaveGroups?: readonly string[];
} = {}) {
  const scope = (stays: boolean): WaveScope => ({
    stays,
    reasons: stays ? [StayReason.MEMBERS_ONLY] : [],
    recordsWaveConfigured: true,
    movedOnChain: false
  });
  const stays = (id: string | null | undefined) => !!id && staying.includes(id);
  return {
    waveStays: jest
      .spyOn(wavesScopeService, 'waveStays')
      .mockImplementation(async (id) => stays(id)),
    waveScopes: jest
      .spyOn(wavesScopeService, 'waveScopes')
      .mockImplementation(
        async (ids) => new Map(ids.map((id) => [id, scope(stays(id))]))
      ),
    movingWaveIds: jest
      .spyOn(wavesScopeService, 'movingWaveIds')
      .mockImplementation(
        async (ids) => new Set(ids.filter((id) => !stays(id)))
      ),
    staysForDisplay: jest
      .spyOn(wavesScopeService, 'staysForDisplay')
      .mockImplementation(
        async (ids) => new Map(ids.map((id) => [id, stays(id)]))
      ),
    usedByMovingWave: jest
      .spyOn(wavesScopeService, 'usedByMovingWave')
      .mockImplementation(async (ids) =>
        ids.some((id) => movingWaveGroups.includes(id))
      ),
    decisionRefs: jest
      .spyOn(wavesScopeService, 'decisionRefs')
      .mockImplementation(async () => new Map())
  };
}
