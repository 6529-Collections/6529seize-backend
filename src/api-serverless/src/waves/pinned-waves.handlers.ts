import * as Joi from 'joi';
import { getAuthenticationContext } from '@/api/auth/auth';
import { userGroupsService } from '@/api/community-members/user-groups.service';
import { ApiUpdatePinnedWaveOrder } from '@/api/generated/models/ApiUpdatePinnedWaveOrder';
import {
  GetPinnedWavesRequest,
  GetPinnedWavesResponse,
  UpdatePinnedWaveOrderRequest,
  UpdatePinnedWaveOrderResponse
} from '@/api/generated/routes/operations';
import { getValidatedByJoiOrThrow } from '@/api/validation';
import { apiWaveOverviewMapper } from '@/api/waves/api-wave-overview.mapper';
import { getAuthenticatedNonProxyProfileIdOrThrow } from '@/api/waves/wave-access.helpers';
import { wavesApiDb } from '@/api/waves/waves.api.db';
import { BadRequestException, CustomApiCompliantException } from '@/exceptions';
import { RequestContext } from '@/request.context';
import { Timer } from '@/time';

const orderIds = Joi.array()
  .items(Joi.string().min(1).max(100))
  .unique()
  .max(1000);
const orderSchema = Joi.object<ApiUpdatePinnedWaveOrder>({
  previous_wave_ids: orderIds.required(),
  wave_ids: orderIds.required()
});

async function getPinnedWavesContext(
  req: GetPinnedWavesRequest | UpdatePinnedWaveOrderRequest
) {
  const timer = Timer.getFromRequest(req);
  const ctx = {
    timer,
    authenticationContext: await getAuthenticationContext(req, timer)
  };
  const profileId = getAuthenticatedNonProxyProfileIdOrThrow(
    ctx,
    'Proxy is not allowed to manage pinned waves'
  );
  const eligibleGroups = await userGroupsService.getGroupsUserIsEligibleFor(
    profileId,
    timer
  );
  return { ctx, profileId, eligibleGroups };
}

async function findReadableRootPins(
  waveIds: string[],
  eligibleGroups: string[],
  ctx: RequestContext
) {
  const waves = await wavesApiDb.findWavesByIds(
    waveIds,
    eligibleGroups,
    ctx.connection
  );
  return new Map(
    waves
      .filter((wave) => wave.parent_wave_id === null && !wave.is_direct_message)
      .map((wave) => [wave.id, wave])
  );
}

export async function handleGetPinnedWaves(
  req: GetPinnedWavesRequest
): Promise<GetPinnedWavesResponse> {
  const { ctx, profileId, eligibleGroups } = await getPinnedWavesContext(req);
  const { waveIds, readableWaves } =
    await wavesApiDb.executeNativeQueriesInTransaction(async (connection) => {
      const txCtx = { ...ctx, connection };
      const pins = await wavesApiDb.findPinnedWavePositions(profileId, txCtx);
      const waveIds = pins.map((pin) => pin.wave_id);
      const readableWaves = await findReadableRootPins(
        waveIds,
        eligibleGroups,
        txCtx
      );
      return { waveIds, readableWaves };
    });
  const overviews = await apiWaveOverviewMapper.mapWaves(
    Array.from(readableWaves.values()),
    ctx,
    { groupIdsUserIsEligibleFor: eligibleGroups }
  );
  return waveIds.flatMap((id) => {
    const wave = overviews[id];
    if (!wave?.context_profile_context) return [];
    return [
      {
        ...wave,
        context_profile_context: {
          ...wave.context_profile_context,
          pinned: true
        }
      }
    ];
  });
}

export async function handleUpdatePinnedWaveOrder(
  req: UpdatePinnedWaveOrderRequest
): Promise<UpdatePinnedWaveOrderResponse> {
  const { previous_wave_ids: previous, wave_ids: desired } =
    getValidatedByJoiOrThrow(req.body, orderSchema);
  const desiredIds = new Set(desired);
  if (
    previous.length !== desired.length ||
    previous.some((id) => !desiredIds.has(id))
  ) {
    throw new BadRequestException(
      'The new order must contain the same pinned waves'
    );
  }

  const { ctx, profileId, eligibleGroups } = await getPinnedWavesContext(req);
  return await wavesApiDb.executeNativeQueriesInTransaction(
    async (connection) => {
      const txCtx = { ...ctx, connection };
      if (!(await wavesApiDb.lockPinnedWaveProfile(profileId, txCtx))) {
        throw new CustomApiCompliantException(
          409,
          'The pinned wave list changed. Reload it and try again.'
        );
      }
      const pins = await wavesApiDb.initializePinnedWavePositions(
        profileId,
        eligibleGroups,
        txCtx
      );
      const readableWaves = await findReadableRootPins(
        pins.map((pin) => pin.wave_id),
        eligibleGroups,
        txCtx
      );
      const readablePins = pins.filter((pin) => readableWaves.has(pin.wave_id));
      const current = readablePins.map((pin) => pin.wave_id);
      if (
        current.length !== previous.length ||
        current.some((id, index) => id !== previous[index])
      ) {
        throw new CustomApiCompliantException(
          409,
          'The pinned wave list changed. Reload it and try again.'
        );
      }
      await wavesApiDb.updatePinnedWavePositions(
        profileId,
        readablePins.flatMap((pin, index) =>
          pin.wave_id === desired[index]
            ? []
            : [{ wave_id: desired[index], position: pin.position }]
        ),
        txCtx
      );
      return { wave_ids: desired };
    },
    { isolationLevel: 'READ COMMITTED' }
  );
}
