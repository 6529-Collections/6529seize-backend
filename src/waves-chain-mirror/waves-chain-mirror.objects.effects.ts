import { userGroupsService } from '@/api/community-members/user-groups.service';
import { chainGatewayClient } from '@/chain-gateway/chain-gateway.client';
import { competitionValidationWave } from '@/api/competitions/competition-configuration';
import { waveApiService } from '@/api/waves/wave.api.service';
import {
  waveScoreService,
  WaveScoreDirtyRefreshReason
} from '@/api/waves/wave-score.service';
import { wavesChangedNotifier } from '@/api/waves/waves-changed.notifier';
import { wavesMappers } from '@/api/waves/waves.mappers';
import { userGroupsDb } from '@/user-groups/user-groups.db';
import { ObjectEffects } from './waves-chain-mirror.objects';

/**
 * What 6529.io's own group and wave writes do after they commit, for the
 * mirror's writes: the group caches and eligibility (a list's members
 * bumped one by one, a criteria group's change bumped for all), the
 * creator's wave list on their sockets, and the wave score refresh.
 * Notifications of a new wave are left to the notifications built from the
 * chain's event log (WAVE_CREATED).
 */
export const defaultObjectEffects: ObjectEffects = {
  async groupsChanged(groupIds, profileIds) {
    if (profileIds.length) await userGroupsDb.insertGroupChanges(profileIds);
    await userGroupsService.onWaveRelatedGroupsChanged(groupIds, {});
  },
  async waveChanged({ waveId, groupIds, followerId }) {
    await userGroupsService.onWaveRelatedGroupsChanged(groupIds, {});
    if (followerId) {
      await waveScoreService.requestWaveScoreRefreshBestEffort(
        [waveId],
        WaveScoreDirtyRefreshReason.DROP_CHANGED
      );
      await wavesChangedNotifier.notify([
        { profileId: followerId, waveIds: [waveId], reason: 'FOLLOWED' }
      ]);
    }
  },
  waveManager: ({ waveId, principal, height }) =>
    waveManagerOf(waveId, principal, height),
  newWaveEntity: ({ id, createdAt, request, createdBy, descriptionDropId }) =>
    wavesMappers.createWaveToNewWaveEntity({
      id,
      serial_no: null,
      created_at: createdAt,
      updated_at: null,
      request,
      created_by: createdBy,
      descriptionDropId,
      nextDecisionTime: null,
      isDirectMessage: false
    }),
  checkCompetition: (draft, wave) =>
    waveApiService.validateNativeCompetitionConfiguration(
      competitionValidationWave(draft, wave),
      {}
    ),
  decisionCreatedAt: (decisionId) => decisionCreatedAt(decisionId)
};

/**
 * Whether the chain counts `principal` a manager of the chain wave
 * `waveId`: the gateway's /v1/waves/{waveId}/rights/{principal}, isManager,
 * read at `height` (the chain index's read height; a rebuild's recorded
 * gateway answers at its mark), else at the client's pin. Null when the
 * gateway can't say: an error, 503 unavailable, a height gone, an answer
 * without isManager, or the node's not_found. The caller has found the
 * wave and the principal on the chain, so a not_found is a read behind
 * them, not a "no".
 */
export async function waveManagerOf(
  waveId: string,
  principal: string,
  height: number | null = null
): Promise<boolean | null> {
  try {
    const answer = await chainGatewayClient.read<{ isManager?: unknown }>(
      `/v1/waves/${waveId}/rights/${principal}`,
      {},
      height === null ? {} : { height }
    );
    const isManager = answer?.data?.isManager;
    return typeof isManager === 'boolean' ? isManager : null;
  } catch {
    return null;
  }
}

function positive(value: unknown): number | null {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * The time of the block a decision's first policy version took effect at
 * (/v1/decisions/{id}/policies, then /v1/blocks/{height}); null when the
 * gateway can't say.
 */
export async function decisionCreatedAt(
  decisionId: string
): Promise<number | null> {
  try {
    const answer = await chainGatewayClient.read<unknown>(
      `/v1/decisions/${decisionId}/policies`
    );
    const data = answer?.data as Record<string, unknown> | unknown[] | null;
    const list = Array.isArray(data)
      ? data
      : Array.isArray(data?.policies)
        ? data.policies
        : Array.isArray(data?.versions)
          ? data.versions
          : [];
    const first = (list as Record<string, unknown>[])
      .filter((policy) => positive(policy?.version) !== null)
      .sort((a, b) => Number(a.version) - Number(b.version))[0];
    const height = positive(first?.activationHeight);
    if (height === null) return null;
    const block = await chainGatewayClient.read<{ time?: unknown }>(
      `/v1/blocks/${height}`
    );
    return positive(block?.data?.time);
  } catch {
    return null;
  }
}
