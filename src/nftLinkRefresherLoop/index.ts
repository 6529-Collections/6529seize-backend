import { Context, SQSHandler, SQSRecord } from 'aws-lambda';
import { Logger } from '@/logging';
import { doInDbContext } from '@/secrets';
import * as sentryContext from '@/sentry.context';
import { NftLinkResolvingService } from '@/nft-links/nft-link-resolving.service';
import { nftLinkResolver } from '@/nft-links/nft-link-resolver';
import { nftLinksDb } from '@/nft-links/nft-links.db';
import { sqs } from '@/sqs';
import { NftLinkRefreshNotifier } from '@/nftLinkRefresherLoop/nft-link-refresh-notifier';
import { Timer } from '@/time';
import { loggerContext } from '@/logger-context';
import { env } from '@/env';
import {
  NFT_LINK_CLEANUP_RESERVE_MS,
  NFT_LINK_RESOLUTION_TIMEOUT_MS,
  withNftLinkResolutionBudget
} from '@/nft-links/resolution-budget';

const logger = Logger.get('NFT_LINK_REFRESHER');
const nftLinkResolvingService = new NftLinkResolvingService(
  nftLinkResolver,
  nftLinksDb,
  new NftLinkRefreshNotifier(),
  sqs
);

const sqsHandler: SQSHandler = async (event, context) =>
  loggerContext.run({ requestId: context.awsRequestId }, async () => {
    const startedAt = Date.now();
    logger.info({
      stage: 'invocation',
      event: 'start',
      records: event.Records.length
    });
    try {
      await doInDbContext(
        async () => {
          logger.info({
            stage: 'initialization',
            event: 'success',
            elapsed_ms: Date.now() - startedAt
          });
          await Promise.all(
            event.Records.map((record) => processMessage(record, context))
          );
        },
        { logger, entities: [] }
      );
    } finally {
      logger.info({
        stage: 'invocation',
        event: 'finished',
        elapsed_ms: Date.now() - startedAt,
        remaining_ms: context.getRemainingTimeInMillis()
      });
    }
  });

const processMessage = async (record: SQSRecord, context: Context) => {
  const messageBody = record.body;
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
  const lockTtlMs = env.getIntOrNull('NFT_LINK_RESOLVER_LOCK_TTL') ?? 120_000;
  const budgetMs = Math.min(
    NFT_LINK_RESOLUTION_TIMEOUT_MS,
    context.getRemainingTimeInMillis() - NFT_LINK_CLEANUP_RESERVE_MS,
    lockTtlMs - NFT_LINK_CLEANUP_RESERVE_MS
  );
  logger.info({
    stage: 'message',
    message_id: record.messageId,
    budget_ms: budgetMs
  });
  try {
    await withNftLinkResolutionBudget(budgetMs, () =>
      nftLinkResolvingService.attemptResolve(url, { timer })
    );
  } finally {
    logger.info({
      stage: 'message',
      message_id: record.messageId,
      timings: timer.getReport()
    });
  }
};

export const handler = sentryContext.wrapLambdaHandler(sqsHandler);
