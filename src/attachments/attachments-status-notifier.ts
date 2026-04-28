import { attachmentsDb, AttachmentsDb } from '@/attachments/attachments.db';
import { mapAttachmentToApiAttachment } from '@/api/attachments/attachments.mappers';
import { AttachmentEntity } from '@/entities/IAttachment';
import { Logger } from '@/logging';
import { RequestContext } from '@/request.context';
import {
  wsListenersNotifier,
  WsListenersNotifier
} from '@/api/ws/ws-listeners-notifier';

export class AttachmentsStatusNotifier {
  private readonly logger = Logger.get(this.constructor.name);

  constructor(
    private readonly attachmentsDb: AttachmentsDb,
    private readonly wsListenersNotifier: WsListenersNotifier
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
    } catch (error) {
      this.logger.error(
        `Failed to broadcast attachment status update for ${attachment.id}`,
        error
      );
    }
  }
}

export const attachmentsStatusNotifier = new AttachmentsStatusNotifier(
  attachmentsDb,
  wsListenersNotifier
);
