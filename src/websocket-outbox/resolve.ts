import { dbSupplier } from '@/sql-executor';
import { RequestContext } from '@/request.context';
import { DROPS_TABLE, DROP_MEDIA_TABLE } from '@/constants';
import { DropEntity } from '@/entities/IDrop';
import { wsConnectionRepository as connections } from '@/api/ws/ws-connection.repository';
import {
  attachmentStatusUpdateMessage,
  dmUnreadStateChangedMessage,
  dropDeleteMessage,
  dropUpdateRefMessage,
  identityNotificationsChangedMessage,
  nftLinkUpdatedMessage,
  DropUpdateRefType
} from '@/api/ws/ws-message';
import { attachmentsDb } from '@/attachments/attachments.db';
import { mapAttachmentToApiAttachment } from '@/api/attachments/attachments.mappers';
import { nftLinksDb } from '@/nft-links/nft-links.db';
import { mapNftLinkEntityToApiLink } from '@/nft-links/nft-link-api.mapper';
import { wavesApiDb } from '@/api/waves/waves.api.db';
import { DbPoolName } from '@/db-query.options';
import { WebSocketOutboxEvent } from './events';

type Delivery = Extract<WebSocketOutboxEvent, { type: 'delivery' }>;
const deliveries = (ids: string[], message: unknown): Delivery[] =>
  Array.from(new Set(ids)).map((connectionId) => ({
    type: 'delivery',
    connectionId,
    message: JSON.stringify(message)
  }));

/** Resolve current state and audience on the writer; materialize durable recipient jobs atomically. */
export async function resolveWebSocketEvent(
  event: WebSocketOutboxEvent,
  ctx: RequestContext
): Promise<WebSocketOutboxEvent[]> {
  switch (event.type) {
    case 'drop': {
      const drop = await dbSupplier().oneOrNull<DropEntity>(
        `select * from ${DROPS_TABLE} where id = :id`,
        { id: event.dropId },
        { wrappedConnection: ctx.connection }
      );
      if (!drop) return [];
      const recipients = await waveRecipients(drop.wave_id, ctx);
      return deliveries(
        recipients,
        dropUpdateRefMessage({
          drop_id: drop.id,
          wave_id: drop.wave_id,
          author_id: drop.author_id,
          serial_no: drop.serial_no,
          update_type: event.updateType as DropUpdateRefType,
          reason: event.reason
        })
      );
    }
    case 'drop-delete':
      return deliveries(
        await waveRecipients(event.waveId, ctx),
        dropDeleteMessage({
          drop_id: event.dropId,
          wave_id: event.waveId,
          drop_serial: event.serialNo
        })
      );
    case 'identity': {
      const recipients =
        await connections.findNotificationConnectionIdsByIdentityIds(
          [event.profileId],
          ctx
        );
      return deliveries(
        recipients.map((r) => r.connectionId),
        identityNotificationsChangedMessage(event.profileId)
      );
    }
    case 'dm': {
      const states =
        await wavesApiDb.findDmUnreadConversationStatesForIdentities(
          { identityIds: event.profileIds, waveIds: [event.waveId] },
          ctx,
          DbPoolName.WRITE
        );
      const recipients =
        await connections.findNotificationConnectionIdsByIdentityIds(
          event.profileIds,
          ctx
        );
      return states.flatMap((state) =>
        deliveries(
          recipients
            .filter((r) => r.identityId === state.profile_id)
            .map((r) => r.connectionId),
          dmUnreadStateChangedMessage(state)
        )
      );
    }
    case 'attachment': {
      const attachment = await attachmentsDb.findAttachmentById(
        event.attachmentId,
        ctx.connection
      );
      if (!attachment) return [];
      const ids = await connections.findConnectionIdsByIdentityId(
        attachment.owner_profile_id,
        ctx
      );
      for (const waveId of await attachmentsDb.findAttachmentWaveIds(
        event.attachmentId,
        ctx.connection
      ))
        ids.push(...(await waveRecipients(waveId, ctx)));
      return deliveries(
        ids,
        attachmentStatusUpdateMessage(mapAttachmentToApiAttachment(attachment))
      );
    }
    case 'nft': {
      const nft = await nftLinksDb.findByCanonicalIdForNotification(
        event.canonicalId,
        ctx
      );
      return nft
        ? deliveries(
            await connections.findAllConnectionIds(ctx),
            nftLinkUpdatedMessage(mapNftLinkEntityToApiLink(nft))
          )
        : [];
    }
    case 'media': {
      const rows = await dbSupplier().execute<{ drop_id: string }>(
        `select distinct drop_id from ${DROP_MEDIA_TABLE} where media_upload_id = :id`,
        { id: event.uploadId },
        { wrappedConnection: ctx.connection }
      );
      return rows.map((row) => ({
        type: 'drop',
        dropId: row.drop_id,
        updateType: 'DROP_UPDATE',
        reason: 'MEDIA_STATUS'
      }));
    }
    case 'delivery':
      throw new Error('Recipient jobs must be enqueued, not resolved');
  }
}

async function waveRecipients(
  waveId: string,
  ctx: RequestContext
): Promise<string[]> {
  const groupId = await connections.findWaveVisibilityGroupId(waveId, ctx);
  if (groupId === undefined) return [];
  return (
    await connections.getCurrentlyOnlineCommunityMemberConnectionIdsForSystemBroadcast(
      { waveId, groupId },
      ctx
    )
  ).map((r) => r.connectionId);
}
