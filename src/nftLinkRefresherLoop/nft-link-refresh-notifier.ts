import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand
} from '@aws-sdk/client-apigatewaymanagementapi';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import { setMaxListeners } from 'node:events';
import { ApiNftLinkData } from '@/api/generated/models/ApiNftLinkData';
import { nftLinkUpdatedMessage } from '@/api/ws/ws-message';
import { nftLinkRefreshNotifierDb } from '@/nftLinkRefresherLoop/nft-link-refresh-notifier.db';
import { Logger } from '@/logging';
import {
  getNftLinkResolutionBudget,
  nftLinkResolutionStage
} from '@/nft-links/resolution-budget';

const NOTIFICATION_TIMEOUT_MS = 15_000;
const MAX_CONCURRENT_SENDS = 10;
const logger = Logger.get('NFT_LINK_REFRESH_NOTIFIER');

type Send = (
  connectionId: string,
  message: string,
  signal: AbortSignal
) => Promise<unknown>;

export class NftLinkRefreshNotifier {
  private client: ApiGatewayManagementApiClient | undefined;

  constructor(
    private readonly listRecipients = () =>
      nftLinkRefreshNotifierDb.findActiveRecipients({}),
    private readonly send: Send = (connectionId, message, signal) =>
      this.getClient().send(
        new PostToConnectionCommand({
          ConnectionId: connectionId,
          Data: Buffer.from(message)
        }),
        { abortSignal: signal }
      )
  ) {}

  private getClient(): ApiGatewayManagementApiClient {
    this.client ??= new ApiGatewayManagementApiClient({
      endpoint: process.env.API_GATEWAY_WS_ENDPOINT,
      maxAttempts: 1,
      requestHandler: new NodeHttpHandler({
        connectionTimeout: 2000,
        requestTimeout: 5000,
        throwOnRequestTimeout: true
      })
    });
    return this.client;
  }

  async notifyAboutNftLinkUpdate(data: ApiNftLinkData): Promise<void> {
    const budget = getNftLinkResolutionBudget();
    const controller = new AbortController();
    // Each of the bounded SDK sends can attach transport cancellation listeners.
    setMaxListeners(MAX_CONCURRENT_SENDS * 3, controller.signal);
    const abort = () => controller.abort();
    const timeoutMs = Math.min(
      NOTIFICATION_TIMEOUT_MS,
      budget?.remainingMs() ?? NOTIFICATION_TIMEOUT_MS
    );
    if (timeoutMs <= 0 || budget?.signal.aborted) {
      logger.info({ event: 'notification_skipped', reason: 'deadline' });
      return;
    }
    budget?.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    let onAbort: (() => void) | undefined;
    try {
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () =>
          reject(new Error('NFT link notification deadline exceeded'));
        controller.signal.addEventListener('abort', onAbort, { once: true });
      });
      // Only the read and cancellable sends are raced. No DB writes or stale
      // connection deletion can resume after this best-effort stage returns.
      await Promise.race([this.broadcast(data, controller.signal), aborted]);
    } catch {
      // Recipient lookup errors can contain connection details. Report only the
      // failure category because notification is best-effort after persistence.
      logger.warn({
        event: 'notification_incomplete',
        reason: controller.signal.aborted
          ? 'deadline'
          : 'recipient_lookup_failed'
      });
    } finally {
      clearTimeout(timer);
      controller.abort();
      if (onAbort) controller.signal.removeEventListener('abort', onAbort);
      budget?.signal.removeEventListener('abort', abort);
    }
  }

  private async broadcast(
    data: ApiNftLinkData,
    signal: AbortSignal
  ): Promise<void> {
    const recipients = await nftLinkResolutionStage(
      'notification_recipients',
      this.listRecipients
    );
    if (signal.aborted) return;
    const message = JSON.stringify(nftLinkUpdatedMessage(data));
    let next = 0;
    let failed = 0;
    const worker = async () => {
      while (!signal.aborted && next < recipients.length) {
        const recipient = recipients[next++];
        if (Number(recipient.jwt_expiry) <= Date.now() / 1000) continue;
        try {
          await this.send(recipient.connection_id, message, signal);
        } catch {
          // Gone/slow connections must not prevent delivery to other clients.
          failed++;
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(MAX_CONCURRENT_SENDS, recipients.length) },
        worker
      )
    );
    logger.info({
      event: 'notification_finished',
      recipients: recipients.length,
      attempted: next,
      failed
    });
  }
}
