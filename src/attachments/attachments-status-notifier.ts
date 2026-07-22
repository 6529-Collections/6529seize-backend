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
import type { ApiDrop } from '@/api/generated/models/ApiDrop';

interface AttachmentBroadcastData {
  readonly waveIds: string[];
  readonly drops: ApiDrop[];
}

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
      const { waveIds, drops } = await this.loadBroadcastData(
        attachment.id,
        ctx
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
      await Promise.all(
        drops.map((drop) =>
          this.wsListenersNotifier.notifyAboutDropUpdate(drop, ctx, {
            useSystemBroadcastAudience: true
          })
        )
      );
    } catch (error) {
      this.logger.error(
        `Failed to broadcast attachment status update for ${attachment.id}`,
        error
      );
    }
  }

  private async loadBroadcastData(
    attachmentId: string,
    ctx: RequestContext
  ): Promise<AttachmentBroadcastData> {
    const load = async (
      consistentCtx: RequestContext
    ): Promise<AttachmentBroadcastData> => {
      const dropsService = this.dropsService;
      const waveIdsPromise = this.attachmentsDb.findAttachmentWaveIds(
        attachmentId,
        consistentCtx.connection
      );
      const dropsPromise = dropsService
        ? this.attachmentsDb
            .findAttachmentDropIds(attachmentId, consistentCtx.connection)
            .then(async (dropIds) => {
              const drops = await Promise.all(
                dropIds.map(async (dropId) => {
                  try {
                    return await dropsService.findDropByIdOrThrow(
                      {
                        dropId,
                        skipEligibilityCheck: true
                      },
                      consistentCtx
                    );
                  } catch (error) {
                    this.logger.error(
                      `Failed to load drop ${dropId} for attachment ${attachmentId}`,
                      error
                    );
                    return null;
                  }
                })
              );
              return drops.filter((drop): drop is ApiDrop => drop !== null);
            })
            .catch((error) => {
              this.logger.error(
                `Failed to load full drop updates for attachment ${attachmentId}`,
                error
              );
              return [];
            })
        : Promise.resolve([]);
      const [waveIds, drops] = await Promise.all([
        waveIdsPromise,
        dropsPromise
      ]);
      return { waveIds, drops };
    };

    if (ctx.connection) {
      return load(ctx);
    }

    return this.attachmentsDb.executeNativeQueriesInTransaction(
      async (connection) => load({ ...ctx, connection })
    );
  }
}

export const attachmentsStatusNotifier = new AttachmentsStatusNotifier(
  attachmentsDb,
  wsListenersNotifier,
  dropsService
);
