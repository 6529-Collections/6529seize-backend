import { randomUUID } from 'node:crypto';
import { dropsDb } from './drops/drops.db';
import { DropType } from './entities/IDrop';
import { IdentityNotificationCause } from './entities/IIdentityNotification';
import { identitiesDb } from './identities/identities.db';
import { Logger } from './logging';
import { identityNotificationsDb } from './notifications/identity-notifications.db';
import { RequestContext } from './request.context';
import { dbSupplier } from './sql-executor';
import { Time, Timer } from './time';
import { userGroupsDb } from './user-groups/user-groups.db';

const logger = Logger.get('PRIORITY_ALERTS');

export function isConfigured() {
  return !!process.env.PRIORITY_ALERTS_WAVE;
}

export function wrapAsyncFunction<TResult = any>(
  alertTitle: string,
  fn: () => Promise<TResult>
): () => Promise<TResult> {
  return async () => {
    try {
      return await fn();
    } catch (error: any) {
      await sendPriorityAlert(alertTitle, error);
      throw error;
    }
  };
}

export async function sendPriorityAlert(
  alertTitle: string,
  error: unknown
): Promise<void> {
  if (!isConfigured()) {
    logger.info(
      'Priority alerts not configured - PRIORITY_ALERTS_WAVE env var not set - skipping priority alerts'
    );
    return;
  }
  const priorityWaveId = process.env.PRIORITY_ALERTS_WAVE!;
  try {
    await handlePriorityAlert(priorityWaveId, error, alertTitle);
    logger.info('Priority alert sent successfully');
  } catch (alertError: any) {
    logger.error('Failed to send priority alert', alertError);
    if (alertError?.stack) {
      logger.error('Failed to send priority alert - stack', alertError.stack);
    }
  }
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
      const wave = await dropsDb.findWaveByIdOrNull(waveId, connection);
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
      const memberIds = await userGroupsDb.findIdentitiesInGroups(
        groupIds,
        ctx
      );

      if (memberIds.length === 0) {
        throw new Error(`No members found in groups for wave ${waveId}`);
      }

      const errorMessage = formatErrorMessage(error);
      const dropId = randomUUID();

      const senderIdentity = await identitiesDb.getIdentityByHandle(
        'punk6529',
        ctx
      );
      if (!senderIdentity) {
        throw new Error(`Identity 'punk6529' not found`);
      }
      if (!senderIdentity.profile_id) {
        throw new Error(`Identity 'punk6529' has no profile ID`);
      }
      const senderId = senderIdentity.profile_id;

      logger.info(
        `Creating priority alert drop in wave ${waveId} with author ${senderId}`
      );

      await dropsDb.insertDrop(
        {
          id: dropId,
          author_id: senderId,
          title: `Priority Alert: ${alertTitle}`,
          parts_count: 1,
          wave_id: waveId,
          reply_to_drop_id: null,
          reply_to_part_id: null,
          created_at: Time.currentMillis(),
          updated_at: null,
          serial_no: null,
          drop_type: DropType.CHAT,
          signature: null
        },
        connection
      );

      await dropsDb.insertDropParts(
        [
          {
            drop_id: dropId,
            drop_part_id: 1,
            content: errorMessage,
            quoted_drop_id: null,
            quoted_drop_part_id: null,
            wave_id: waveId
          }
        ],
        connection,
        timer
      );

      logger.info(
        `Priority alert drop created with id ${dropId} in wave ${waveId}`
      );

      const memberIdsToNotify = memberIds.filter((id) => id !== senderId);

      await Promise.all(
        memberIdsToNotify.map((id) =>
          identityNotificationsDb.insertNotification(
            {
              identity_id: id,
              additional_identity_id: senderId,
              related_drop_id: dropId,
              related_drop_part_no: null,
              related_drop_2_id: null,
              related_drop_2_part_no: null,
              wave_id: waveId,
              cause: IdentityNotificationCause.PRIORITY_ALERT,
              additional_data: {},
              visibility_group_id: null
            },
            connection
          )
        )
      );

      logger.info(
        `Priority alert sent to ${memberIdsToNotify.length} members in wave ${waveId} for drop ${dropId}`
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
