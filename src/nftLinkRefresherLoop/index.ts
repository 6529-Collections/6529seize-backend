import { SQSHandler } from 'aws-lambda';
import { Logger } from '@/logging';
import { doInDbContext } from '@/secrets';
import * as sentryContext from '@/sentry.context';
import { nftLinkResolvingService } from '@/nft-links/nft-link-resolving.service';
import { Timer } from '@/time';

const logger = Logger.get('NFT_LINK_REFRESHER');

const sqsHandler: SQSHandler = async (event) => {
  await doInDbContext(
    async () => {
      await Promise.all(
        event.Records.map(async (record) => {
          const messageBody = record.body;
          await processMessage(messageBody);
        })
      );
    },
    {
      logger,
      entities: []
    }
  );
};

const processMessage = async (messageBody: string) => {
  if (!messageBody) {
    return;
  }

  let url;
  try {
    const req = JSON.parse(messageBody);
    url = req?.rawUrl;
  } catch (e) {
    //ignore
  }

  if (!url || typeof url !== 'string') {
    logger.info(
      `rawUrl missing from message body or is of wrong type, discarding message`
    );
    return;
  }
  const timer = new Timer('NFT_LINK_RESOLVER');
  await nftLinkResolvingService.attemptResolve(url, { timer });
  logger.info(`Resolving link ${url} took ${timer.getReport()}`);
};

export const handler = sentryContext.wrapLambdaHandler(sqsHandler);
