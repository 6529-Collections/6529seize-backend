import { userGroupsService } from './api-serverless/src/community-members/user-groups.service';
import { wavesApiDb } from './api-serverless/src/waves/waves.api.db';
import { createOrUpdateDrop } from './drops/create-or-update-drop.use-case';
import { DropType } from './entities/IDrop';
import { Logger } from './logging';
import { userNotifier } from './notifications/user.notifier';
import { RequestContext } from './request.context';
import { dbSupplier } from './sql-executor';
import { Timer } from './time';

const logger = Logger.get('PRIORITY_ALERTS');

export function isConfigured() {
  return !!process.env.PRIORITY_ALERTS_WAVE;
}

export function wrapAsyncFunction<TResult = any>(
  alertTitle: string,
  fn: () => Promise<TResult>
): () => Promise<TResult> {
  return async () => {
    let priorityWaveId = null;
    if (isConfigured()) {
      priorityWaveId = process.env.PRIORITY_ALERTS_WAVE!;
    } else {
      logger.info(
        'Priority alerts not configured - PRIORITY_ALERTS_WAVE env var not set - skipping priority alerts'
      );
    }

    try {
      return await fn();
    } catch (error: any) {
      if (priorityWaveId) {
        try {
          await handlePriorityAlert(priorityWaveId, error, alertTitle);
          logger.info('Priority alert sent successfully');
        } catch (alertError: any) {
          logger.error('Failed to send priority alert', alertError);
          if (alertError?.stack) {
            logger.error(
              'Failed to send priority alert - stack',
              alertError.stack
            );
          }
        }
      }

      throw error;
    }
  };
}

async function handlePriorityAlert(
  waveId: string,
  error: any,
  alertTitle: string
) {
  const timer = new Timer('priorityAlerts->handlePriorityAlert');
  timer.start('priorityAlerts->handlePriorityAlert');

  try {
    logger.info(`Sending priority alert for wave ${waveId}`);
    const db = dbSupplier();
    await db.executeNativeQueriesInTransaction(async (connection) => {
      const wave = await wavesApiDb.findWaveById(waveId, connection);
      if (!wave) {
        throw new Error(`Wave ${waveId} not found`);
      }

      const groupIds = [
        wave.visibility_group_id,
        wave.chat_group_id,
        wave.participation_group_id,
        wave.voting_group_id,
        wave.admin_group_id
      ].filter((id): id is string => id !== null);

      if (groupIds.length === 0) {
        throw new Error(`Wave ${waveId} has no group IDs`);
      }

      const ctx: RequestContext = { connection, timer };
      const memberIds = await userGroupsService.findIdentitiesInGroups(
        groupIds,
        ctx
      );

      if (memberIds.length === 0) {
        throw new Error(`No members found in groups for wave ${waveId}`);
      }

      const errorMessage = formatErrorMessage(error);

      logger.info(
        `Creating priority alert drop in wave ${waveId} with author ${wave.created_by}`
      );

      const { drop_id } = await createOrUpdateDrop.execute(
        {
          drop_id: null,
          wave_id: waveId,
          reply_to: null,
          title: `Priority Alert: ${alertTitle}`,
          parts: [
            {
              content: errorMessage,
              quoted_drop: null,
              media: []
            }
          ],
          referenced_nfts: [],
          mentioned_users: [],
          metadata: [],
          author_identity: wave.created_by,
          author_id: wave.created_by,
          drop_type: DropType.CHAT,
          mentions_all: false,
          signature: null
        },
        false,
        { timer, connection }
      );

      logger.info(
        `Priority alert drop created with id ${drop_id} in wave ${waveId}`
      );

      await userNotifier.notifyPriorityAlert(
        {
          waveId,
          dropId: drop_id,
          relatedIdentityId: wave.created_by,
          memberIds
        },
        ctx
      );

      logger.info(
        `Priority alert sent to ${memberIds.length} members in wave ${waveId} for drop ${drop_id}`
      );
    });
  } finally {
    timer.stop('priorityAlerts->handlePriorityAlert');
  }
}

function formatErrorMessage(error: any): string {
  const errorName = error?.name || 'UnknownError';
  const errorMessage = error?.message || String(error);
  const stack = error?.stack || '';

  const maxLength = 30000;
  let message = `**${errorName}**\n\n${errorMessage}`;

  if (stack) {
    const stackPreview = stack.substring(0, maxLength - message.length - 100);
    message += `\n\n\`\`\`\n${stackPreview}${stack.length > stackPreview.length ? '...' : ''}\n\`\`\``;
  }

  if (message.length > maxLength) {
    message = message.substring(0, maxLength - 3) + '...';
  }

  return message;
}
