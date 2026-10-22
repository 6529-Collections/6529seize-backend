import { withMediaDependencySmoke } from '@/media/media-dependency-smoke';
import { SQSHandler } from 'aws-lambda';
import { Logger } from '@/logging';
import { doInDbContext } from '@/secrets';
import * as sentryContext from '@/sentry.context';
import { nftLinkMediaPreviewService } from '@/nft-links/nft-link-media-preview.service';
import { Timer } from '@/time';
import { observePreviewBacklog } from '@/nftLinkMediaPreviewLoop/loop-health';

const logger = Logger.get('NFT_LINK_MEDIA_PREVIEW_LOOP');

const sqsHandler: SQSHandler = async (event, context) => {
  const observe = async () => {
    if (
      !context?.getRemainingTimeInMillis ||
      context.getRemainingTimeInMillis() > 5000
    )
      await observePreviewBacklog();
  };
  await doInDbContext(
    async () => {
      try {
        for (const record of event.Records) {
          const timer = new Timer('NFT_LINK_MEDIA_PREVIEW');
          await nftLinkMediaPreviewService.processQueueMessage(record.body, {
            timer
          });
          logger.info(`Preview job processed in ${timer.getReport()}`);
        }
      } finally {
        await observe();
      }
    },
    {
      logger,
      entities: []
    }
  );
};

export const handler = withMediaDependencySmoke(
  sentryContext.wrapLambdaHandler(sqsHandler)
);
