import { giveReadReplicaTimeToCatchUp } from '@/api/api-helpers';
import { dropsService, DropsApiService } from '@/api/drops/drops.api.service';
import {
  wsListenersNotifier,
  WsListenersNotifier
} from '@/api/ws/ws-listeners-notifier';
import { DROP_UPDATE_REASON_MEDIA_STATUS } from '@/api/ws/ws-message';
import {
  dropMediaUploadsDb,
  DropMediaUploadsDb
} from '@/drops/drop-media-uploads.db';
import { Logger } from '@/logging';
import { RequestContext } from '@/request.context';

export class DropMediaUploadStatusNotifier {
  private readonly logger = Logger.get(this.constructor.name);

  constructor(
    private readonly dropMediaUploadsDb: DropMediaUploadsDb,
    private readonly wsListenersNotifier: WsListenersNotifier,
    private readonly dropsService?: DropsApiService
  ) {}

  public async notifyStatusTransition(
    mediaUploadId: string,
    ctx: RequestContext = {}
  ): Promise<void> {
    if (!this.dropsService) {
      return;
    }
    try {
      const dropIds =
        await this.dropMediaUploadsDb.findDropIdsByUploadId(mediaUploadId);
      if (!dropIds.length) {
        return;
      }
      await giveReadReplicaTimeToCatchUp();
      const results = await Promise.allSettled(
        dropIds.map(async (dropId) => {
          const drop = await this.dropsService!.findDropByIdOrThrow(
            {
              dropId,
              skipEligibilityCheck: true
            },
            ctx
          );
          await this.wsListenersNotifier.notifyAboutDropUpdate(drop, ctx, {
            reason: DROP_UPDATE_REASON_MEDIA_STATUS,
            useSystemBroadcastAudience: true
          });
        })
      );
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          this.logger.error(
            `Failed to broadcast drop media upload status for drop ${dropIds[index]}`,
            result.reason
          );
        }
      });
    } catch (error) {
      this.logger.error(
        `Failed to broadcast drop media upload status for ${mediaUploadId}`,
        error
      );
    }
  }
}

export const dropMediaUploadStatusNotifier = new DropMediaUploadStatusNotifier(
  dropMediaUploadsDb,
  wsListenersNotifier,
  dropsService
);
