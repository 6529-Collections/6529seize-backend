import { attachmentsDb, AttachmentsDb } from '@/attachments/attachments.db';
import { mapAttachmentToApiAttachment } from '@/api/attachments/attachments.mappers';
import { AttachmentEntity } from '@/entities/IAttachment';
import { Logger } from '@/logging';
import { RequestContext } from '@/request.context';
import {
  wsListenersNotifier,
  WsListenersNotifier
} from '@/api/ws/ws-listeners-notifier';
import { dropsService, DropsApiService } from '@/api/drops/drops.api.service';
import { giveReadReplicaTimeToCatchUp } from '@/api/api-helpers';

export class AttachmentsStatusNotifier {
  private readonly logger = Logger.get(this.constructor.name);

  constructor(
    private readonly attachmentsDb: AttachmentsDb,
    private readonly wsListenersNotifier: WsListenersNotifier,
    private readonly dropsService?: DropsApiService
  ) {}

  public async notifyStatusTransition(
    attachment: AttachmentEntity,
    ctx: RequestContext = {}
  ): Promise<void> {
    try {
      const waveIds = await this.attachmentsDb.findAttachmentWaveIds(
        attachment.id
      );
      const apiAttachment = mapAttachmentToApiAttachment(attachment);
      await this.wsListenersNotifier.notifyAboutAttachmentStatusUpdate(
        {
          attachment: apiAttachment,
          ownerProfileId: attachment.owner_profile_id,
          waveIds
        },
        ctx
      );
      await this.notifyDropUpdates(attachment.id, ctx);
    } catch (error) {
      this.logger.error(
        `Failed to broadcast attachment status update for ${attachment.id}`,
        error
      );
    }
  }

  private async notifyDropUpdates(
    attachmentId: string,
    ctx: RequestContext
  ): Promise<void> {
    if (!this.dropsService) {
      return;
    }
    const dropsService = this.dropsService;
    const dropIds =
      await this.attachmentsDb.findAttachmentDropIds(attachmentId);
    if (!dropIds.length) {
      return;
    }
    await giveReadReplicaTimeToCatchUp();
    await Promise.all(
      dropIds.map(async (dropId) => {
        const drop = await dropsService.findDropByIdOrThrow(
          {
            dropId,
            skipEligibilityCheck: true
          },
          ctx
        );
        await this.wsListenersNotifier.notifyAboutDropUpdate(drop, ctx, {
          useSystemBroadcastAudience: true
        });
      })
    );
  }
}

export const attachmentsStatusNotifier = new AttachmentsStatusNotifier(
  attachmentsDb,
  wsListenersNotifier,
  dropsService
);
