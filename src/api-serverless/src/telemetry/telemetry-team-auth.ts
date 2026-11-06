import { Request } from 'express';
import { getAuthenticationContext } from '@/api/auth/auth';
import { userGroupsService } from '@/api/community-members/user-groups.service';
import { wavesApiDb } from '@/api/waves/waves.api.db';
import { env } from '@/env';
import { ForbiddenException } from '@/exceptions';

/**
 * Team-only telemetry reads (diagnostics bundles, internal dashboards).
 *
 * Owner decision: readers are the people with write access in the dev-team
 * chat wave ("Follow The Repo"), configured as `TELEMETRY_DIAG_READER_WAVE_ID`.
 * It is a live check on every request: the signed-in profile (not a proxy)
 * must currently be eligible for that wave's chat group, using the same group
 * eligibility code that decides who may post. Removing someone from the
 * group removes their access on the next request. If the wave id is unset,
 * the wave cannot be found, its chat is off, or its chat is open to
 * everyone, nobody has access.
 */
export const TELEMETRY_READER_WAVE_ENV = 'TELEMETRY_DIAG_READER_WAVE_ID';

function forbidden(): ForbiddenException {
  return new ForbiddenException('Telemetry data is team-only');
}

async function readerChatGroupId(): Promise<string | null> {
  const waveId = env.getStringOrNull(TELEMETRY_READER_WAVE_ENV)?.trim();
  if (!waveId) {
    return null;
  }
  const wave = await wavesApiDb.findWaveById(waveId);
  if (!wave?.chat_enabled || !wave.chat_group_id) {
    return null;
  }
  return wave.chat_group_id;
}

/** Returns the reader's profile id, or throws 403. */
export async function assertTelemetryTeamReader(
  req: Request<any, any, any, any, any>
): Promise<string> {
  const chatGroupId = await readerChatGroupId();
  if (!chatGroupId) {
    throw forbidden();
  }
  const authContext = await getAuthenticationContext(req);
  const profileId = authContext.authenticatedProfileId;
  if (!profileId || authContext.isAuthenticatedAsProxy()) {
    throw forbidden();
  }
  const eligibleGroupIds =
    await userGroupsService.getGroupsUserIsEligibleForByIds(profileId, [
      chatGroupId
    ]);
  if (!eligibleGroupIds.includes(chatGroupId)) {
    throw forbidden();
  }
  return profileId;
}
