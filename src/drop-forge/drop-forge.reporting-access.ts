import { wavesApiDb } from '@/api/waves/waves.api.db';
import { userGroupsService } from '@/api/community-members/user-groups.service';
import { identitiesDb } from '@/identities/identities.db';
import { DropForgeReportingConfig } from '@/drop-forge/drop-forge.config';
import { LaunchSafetyError } from '@/drop-forge/drop-forge.types';
import { RequestContext } from '@/request.context';

export async function validateForgeReporting(
  config: DropForgeReportingConfig,
  ctx: RequestContext
): Promise<string> {
  const recipientIds = Array.from(new Set(config.recipientIds));
  const [identity, recipients, wave] = await Promise.all([
    identitiesDb.getIdentityByProfileId(config.botId, ctx.connection),
    identitiesDb.getIdentitiesByIds(recipientIds, ctx.connection),
    wavesApiDb.findWaveById(config.waveId, ctx.connection)
  ]);
  const author = identity?.handle ?? identity?.primary_address;
  if (!author || recipients.length !== recipientIds.length)
    throw new LaunchSafetyError('Reporting profiles are not available');
  if (!wave?.chat_enabled)
    throw new LaunchSafetyError('Reporting wave must exist and allow chat');
  const parent = wave.parent_wave_id
    ? await wavesApiDb.findWaveById(wave.parent_wave_id, ctx.connection)
    : null;
  if (wave.parent_wave_id && !parent)
    throw new LaunchSafetyError('Reporting parent wave is not available');
  const visibility = [
    wave.visibility_group_id,
    parent?.visibility_group_id
  ].filter((group): group is string => Boolean(group));
  const botGroups = [...visibility, wave.chat_group_id].filter(
    (group): group is string => Boolean(group)
  );
  const groupIds = Array.from(new Set(botGroups));
  if (!groupIds.length) return author;
  const memberships = await userGroupsService.findIdentityGroupMemberships(
    {
      groupIds,
      profileIds: Array.from(new Set([config.botId, ...recipientIds]))
    },
    ctx
  );
  const eligible = new Set(
    memberships.map((member) => `${member.profileId}:${member.groupId}`)
  );
  if (botGroups.some((group) => !eligible.has(`${config.botId}:${group}`)))
    throw new LaunchSafetyError(
      'Reporting bot cannot read or post to the wave'
    );
  if (
    recipientIds.some((profile) =>
      visibility.some((group) => !eligible.has(`${profile}:${group}`))
    )
  )
    throw new LaunchSafetyError(
      'Alert recipients cannot read the reporting wave'
    );
  return author;
}
