import { AuthenticationContext } from '@/auth-context';
import { ProfileProxyActionType } from '@/entities/IProfileProxyAction';
import { ForbiddenException, NotFoundException } from '@/exceptions';
import { getRequestScopedPromise, RequestContext } from '@/request.context';
import { UserGroupsService } from '@/api/community-members/user-groups.service';
import { WavesApiDb } from '@/api/waves/waves.api.db';

type ManageWaveEntity = {
  id: string;
  admin_group_id: string | null;
  created_by: string;
};

export function getWaveReadContextProfileId(
  authenticationContext?: AuthenticationContext
): string | null {
  if (!authenticationContext?.isUserFullyAuthenticated()) {
    return null;
  }
  if (
    authenticationContext.isAuthenticatedAsProxy() &&
    !authenticationContext.hasProxyAction(ProfileProxyActionType.READ_WAVE)
  ) {
    return null;
  }
  return authenticationContext.getActingAsId();
}

export async function getGroupsUserIsEligibleForReadContext(
  userGroupsService: UserGroupsService,
  ctx: RequestContext
): Promise<string[]> {
  const profileId = getWaveReadContextProfileId(ctx.authenticationContext);
  if (!profileId) {
    return [];
  }
  // Eligibility depends on profileId; ctx.timer only instruments the call.
  return await getRequestScopedPromise(
    ctx,
    `wave-read-eligible-groups:${profileId}`,
    () => userGroupsService.getGroupsUserIsEligibleFor(profileId, ctx.timer)
  );
}

export function assertWaveVisibleOrThrow<
  TWave extends { visibility_group_id: string | null }
>(
  wave: TWave | null,
  groupsUserIsEligibleFor: string[],
  message: string
): asserts wave is TWave {
  if (
    !wave ||
    (wave.visibility_group_id &&
      !groupsUserIsEligibleFor.includes(wave.visibility_group_id))
  ) {
    throw new NotFoundException(message);
  }
}

export async function assertWaveAndParentVisibleOrThrow<
  TWave extends {
    visibility_group_id: string | null;
    parent_wave_id?: string | null;
  }
>({
  wave,
  groupsUserIsEligibleFor,
  message,
  wavesApiDb,
  ctx
}: {
  wave: TWave | null;
  groupsUserIsEligibleFor: string[];
  message: string;
  wavesApiDb: WavesApiDb;
  ctx: RequestContext;
}): Promise<TWave> {
  assertWaveVisibleOrThrow(wave, groupsUserIsEligibleFor, message);

  const parentWaveId = wave.parent_wave_id ?? null;
  if (!parentWaveId) {
    return wave;
  }

  const parentWave = await wavesApiDb.findWaveById(
    parentWaveId,
    ctx.connection
  );
  assertWaveVisibleOrThrow(parentWave, groupsUserIsEligibleFor, message);
  if (parentWave.parent_wave_id !== null) {
    throw new NotFoundException(message);
  }
  return wave;
}

export function getAuthenticatedNonProxyProfileIdOrThrow(
  ctx: RequestContext,
  proxyErrorMessage: string
): string {
  const authenticationContext = ctx.authenticationContext;
  if (!authenticationContext?.isUserFullyAuthenticated()) {
    throw new ForbiddenException(`Please create a profile first`);
  }
  if (authenticationContext.isAuthenticatedAsProxy()) {
    throw new ForbiddenException(proxyErrorMessage);
  }
  const actingAsId = authenticationContext.getActingAsId();
  if (!actingAsId) {
    throw new ForbiddenException(`Please create a profile first`);
  }
  return actingAsId;
}

export async function getWaveManagementContextOrThrow<
  TWave extends ManageWaveEntity
>({
  waveId,
  ctx,
  wavesApiDb,
  userGroupsService,
  proxyErrorMessage,
  forbiddenMessage,
  allowCreator,
  requireAdminGroup,
  missingAdminGroupMessage,
  validateWave
}: {
  waveId: string;
  ctx: RequestContext;
  wavesApiDb: WavesApiDb;
  userGroupsService: UserGroupsService;
  proxyErrorMessage: string;
  forbiddenMessage: string;
  allowCreator: boolean;
  requireAdminGroup: boolean;
  missingAdminGroupMessage?: string;
  validateWave?: (wave: TWave) => void;
}): Promise<{ wave: TWave; profileId: string }> {
  const profileId = getAuthenticatedNonProxyProfileIdOrThrow(
    ctx,
    proxyErrorMessage
  );
  const wave = (await wavesApiDb.findWaveById(
    waveId,
    ctx.connection
  )) as unknown as TWave | null;
  if (!wave) {
    throw new NotFoundException(`Wave ${waveId} not found`);
  }
  if (requireAdminGroup && !wave.admin_group_id) {
    throw new ForbiddenException(
      missingAdminGroupMessage ??
        `Wave ${waveId} does not have an admin group configured`
    );
  }
  const groupsUserIsEligibleFor =
    await userGroupsService.getGroupsUserIsEligibleFor(profileId, ctx.timer);
  const isCreator = allowCreator && wave.created_by === profileId;
  const isAdmin =
    wave.admin_group_id !== null &&
    groupsUserIsEligibleFor.includes(wave.admin_group_id);
  if (!isCreator && !isAdmin) {
    throw new ForbiddenException(forbiddenMessage);
  }
  validateWave?.(wave);
  return { wave, profileId };
}
