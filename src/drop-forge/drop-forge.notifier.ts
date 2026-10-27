import { LaunchSafetyError } from '@/drop-forge/drop-forge.types';
import { RequestContext } from '@/request.context';
import { dropForgeJobsRepository } from '@/drop-forge/drop-forge.jobs.repository';
import { sendIdentityPushNotifications } from '@/api/push-notifications/push-notifications.service';
import { DROPS_6529_MENTION } from '@/constants/mentions';
import { DropForgeReportingConfig } from '@/drop-forge/drop-forge.config';
import { DropForgeRepository } from '@/drop-forge/drop-forge.repository';
import { createOrUpdateDrop } from '@/drops/create-or-update-drop.use-case';
import { dropsDb } from '@/drops/drops.db';
import { DropType } from '@/entities/IDrop';
import { Logger } from '@/logging';
import {
  formatLaunchReport,
  formatOperationsPost
} from '@/drop-forge/drop-forge.reports';
import { validateForgeReporting } from '@/drop-forge/drop-forge.reporting-access';

const logger = Logger.get('DROP_FORGE_REPORTING');
export async function reportLaunchEvents(
  config: DropForgeReportingConfig,
  repository: DropForgeRepository,
  id?: string
): Promise<boolean> {
  const target = id ? await repository.find(id, {}) : null;
  const targeted = target ? [target] : [];
  const candidates = id ? targeted : await repository.reporting({});
  return candidates.reduce(
    (pending, candidate) =>
      pending.then(async (delivered) => {
        const outcome = await reportLaunchCandidate(
          config,
          repository,
          candidate.id
        );
        return outcome && delivered;
      }),
    Promise.resolve(true)
  );
}

async function reportLaunchCandidate(
  config: DropForgeReportingConfig,
  repository: DropForgeRepository,
  id: string
): Promise<boolean> {
  try {
    const pushes = await repository.change(
      id,
      async (record, ctx) => {
        const notifications: number[] = [];
        const events = record.data.events
          .filter((event) => !event.drop_id)
          .slice(0, 5);
        await events.reduce(
          (pending, event) =>
            pending.then(async () => {
              const report = await postForgeReport(
                config,
                formatLaunchReport(record.data, event),
                event.error,
                ctx
              );
              event.drop_id = report.drop_id;
              notifications.push(...report.pending_push_notification_ids);
            }),
          Promise.resolve()
        );
        return notifications;
      },
      {}
    );
    try {
      await sendIdentityPushNotifications(pushes);
    } catch {
      logger.warn('Drop Forge push delivery failed; wave report is durable');
    }
    return true;
  } catch (error_) {
    logger.warn(
      `Drop Forge wave delivery deferred for ${id}`,
      reportDiagnostic(error_)
    );
    return false;
  }
}

export async function postForgeReport(
  config: DropForgeReportingConfig,
  message: string,
  error: boolean,
  ctx: RequestContext
): Promise<{ drop_id: string; pending_push_notification_ids: number[] }> {
  const author = await validateForgeReporting(config, ctx);
  const alert = error ? '\n\n' + DROPS_6529_MENTION : '';
  const { drop_id, pending_push_notification_ids } =
    await createOrUpdateDrop.execute(
      {
        drop_id: null,
        wave_id: config.waveId,
        reply_to: null,
        title: null,
        parts: [
          {
            content: formatOperationsPost(message, error) + alert,
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
  config: DropForgeReportingConfig,
  id?: string
): Promise<boolean> {
  try {
    const pushes = await dropForgeJobsRepository.reportOne(
      (job, ctx) => {
        const reset = job.error === 'Distribution reset; process again';
        const detail = job.error ? '\n' + job.error : '';
        const operation = preparationOperation(job.kind);
        let outcome = 'failed.';
        if (reset) outcome = 'invalidated by an explicit reset.';
        else if (job.status === 'AWAITING_AUTH')
          outcome = 'paused. Sign in to resume EMMA input retrieval.';
        else if (job.status === 'COMPLETED')
          outcome = 'completed. Read-only results are ready.';
        return postForgeReport(
          config,
          `Claim #${job.claim_id}: ${operation} ${outcome}${detail}`,
          ['FAILED', 'AWAITING_AUTH'].includes(job.status) && !reset,
          ctx
        );
      },
      {},
      id
    );
    try {
      await sendIdentityPushNotifications(pushes);
    } catch {
      logger.warn(
        'Drop Forge push delivery failed; preparation report is durable'
      );
    }
    return true;
  } catch (error_) {
    logger.warn(
      'Drop Forge preparation report deferred',
      reportDiagnostic(error_)
    );
    return false;
  }
}

function preparationOperation(kind: string): string {
  if (kind === 'PROCESS_ALL') return 'Distribution processing and finalization';
  if (kind === 'FINALIZE') return 'Distribution finalization';
  return 'Distribution phase preparation';
}
function reportDiagnostic(error_: unknown): {
  error_type: string;
  reason?: string;
} {
  return {
    error_type: error_ instanceof Error ? error_.name : 'UnknownError',
    ...(error_ instanceof LaunchSafetyError ? { reason: error_.message } : {})
  };
}
