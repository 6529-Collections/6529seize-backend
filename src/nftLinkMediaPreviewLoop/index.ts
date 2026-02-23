import { SQSHandler } from 'aws-lambda';
import { Logger } from '@/logging';
import { doInDbContext } from '@/secrets';
import * as sentryContext from '@/sentry.context';
import { nftLinkMediaPreviewService } from '@/nft-links/nft-link-media-preview.service';
import { Timer } from '@/time';

const logger = Logger.get('NFT_LINK_MEDIA_PREVIEW_LOOP');

const sqsHandler: SQSHandler = async (event) => {
  await doInDbContext(
    async () => {
      for (const record of event.Records) {
        const timer = new Timer('NFT_LINK_MEDIA_PREVIEW');
        await nftLinkMediaPreviewService.processQueueMessage(record.body, {
          timer
        });
        logger.info(`Preview job processed in ${timer.getReport()}`);
      }
    },
    {
      logger,
      entities: []
    }
  );
};

export const handler = sentryContext.wrapLambdaHandler(sqsHandler);
