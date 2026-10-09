import { wavesApiDb } from '@/api/waves/waves.api.db';
import { userGroupsService } from '@/api/community-members/user-groups.service';
import { RequestContext } from '@/request.context';
import { dropForgeJobsRepository } from '@/drop-forge/drop-forge.jobs.repository';
import { sendIdentityPushNotifications } from '@/api/push-notifications/push-notifications.service';
import { DROP_FORGERS_6529_MENTION } from '@/constants/mentions';
import { DropForgeReportingConfig } from '@/drop-forge/drop-forge.config';
import { DropForgeRepository } from '@/drop-forge/drop-forge.repository';
import { createOrUpdateDrop } from '@/drops/create-or-update-drop.use-case';
import { dropsDb } from '@/drops/drops.db';
import { DropType } from '@/entities/IDrop';
import { identitiesDb } from '@/identities/identities.db';
import { Logger } from '@/logging';

const logger = Logger.get('DROP_FORGE_REPORTING');
export async function reportLaunchEvents(
  config: DropForgeReportingConfig,
  repository: DropForgeRepository
): Promise<boolean> {
  let delivered = true;
  for (const candidate of await repository.reporting({})) {
    try {
      const pushes = await repository.change(
        candidate.id,
        async (record, ctx) => {
          const notifications: number[] = [];
          for (const event of record.data.events
            .filter((it) => !it.drop_id)
            .slice(0, 5)) {
            const { drop_id, pending_push_notification_ids } =
              await postForgeReport(
                config,
                `Drop Forge ${record.data.contract} / claim ${record.data.claim_id}\n${event.content}`,
                event.error,
                ctx
              );
            event.drop_id = drop_id;
            notifications.push(...pending_push_notification_ids);
          }
          return notifications;
        },
        {}
      );
      // Drop and outbox acknowledgement share a DB commit. Push transport is
      // best effort and cannot roll back or duplicate the wave report.
      try {
        await sendIdentityPushNotifications(pushes);
      } catch {
        logger.warn('Drop Forge push delivery failed; wave report is durable');
      }
    } catch {
      logger.warn(`Drop Forge wave delivery deferred for ${candidate.id}`);
      delivered = false;
    }
  }
  return delivered;
}

export async function postForgeReport(
  config: DropForgeReportingConfig,
  message: string,
  error: boolean,
  ctx: RequestContext
): Promise<{ drop_id: string; pending_push_notification_ids: number[] }> {
  const identity = await identitiesDb.getIdentityByProfileId(
    config.botId,
    ctx.connection
  );
  const recipients = await identitiesDb.getIdentitiesByIds(
    config.recipientIds,
    ctx.connection
  );
  if (!identity || recipients.length !== config.recipientIds.length)
    throw new Error('Reporting profiles are not available');
  const wave = await wavesApiDb.findWaveById(config.waveId, ctx.connection);
  if (!wave) throw new Error('Reporting wave is not available');
  const parent = wave.parent_wave_id
    ? await wavesApiDb.findWaveById(wave.parent_wave_id, ctx.connection)
    : null;
  const groups = Array.from(
    new Set(
      [wave.visibility_group_id, parent?.visibility_group_id].filter(
        (group): group is string => Boolean(group)
      )
    )
  );
  if (groups.length) {
    const memberships = await userGroupsService.findIdentityGroupMemberships(
      { groupIds: groups, profileIds: config.recipientIds },
      ctx
    );
    const eligible = new Set(
      memberships.map((member) => `${member.profileId}:${member.groupId}`)
    );
    if (
      config.recipientIds.some((profile) =>
        groups.some((group) => !eligible.has(`${profile}:${group}`))
      )
    )
      throw new Error('Alert recipients cannot read the reporting wave');
  }
  const author = identity.handle ?? identity.primary_address;
  if (!author) throw new Error('Reporting profile has no identity');
  const { drop_id, pending_push_notification_ids } =
    await createOrUpdateDrop.execute(
      {
        drop_id: null,
        wave_id: config.waveId,
        reply_to: null,
        title: null,
        parts: [
          {
            content: `${message}${error ? `\n\n${DROP_FORGERS_6529_MENTION}` : ''}`,
            quoted_drop: null,
            media: []
          }
        ],
        referenced_nfts: [],
        mentioned_users: [],
        mentioned_waves: [],
        metadata: [],
        author_identity: author,
        author_id: config.botId,
        drop_type: DropType.CHAT,
        mentioned_groups: [],
        signature: null,
        is_additional_action_promised: null
      },
      false,
      {
        connection: ctx.connection!,
        prePublication: { trustedSystem: true },
        bypassChatLinkRestrictions: true,
        bypassChatSlowModeRestrictions: true
      }
    );
  await dropsDb.updateHideLinkPreview(
    { drop_id, hide_link_preview: true },
    ctx
  );
  return { drop_id, pending_push_notification_ids };
}

export async function reportPreparationJob(
  config: DropForgeReportingConfig
): Promise<boolean> {
  try {
    const pushes = await dropForgeJobsRepository.reportOne(
      (job, ctx) =>
        postForgeReport(
          config,
          `Drop Forge preparation ${job.id}: ${job.kind} ${job.contract} / claim ${job.claim_id} ${job.status}${job.error ? `\n${job.error}` : ''}`,
          job.status === 'FAILED',
          ctx
        ),
      {}
    );
    try {
      await sendIdentityPushNotifications(pushes);
    } catch {
      logger.warn(
        'Drop Forge push delivery failed; preparation report is durable'
      );
    }
    return true;
  } catch {
    logger.warn('Drop Forge preparation report deferred');
    return false;
  }
}
