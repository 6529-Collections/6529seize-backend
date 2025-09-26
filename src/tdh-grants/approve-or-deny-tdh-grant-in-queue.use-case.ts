import { tdhGrantsFinder, TdhGrantsFinder } from './tdh-grants.finder';
import { RequestContext } from '../request.context';
import { Logger } from '../logging';
import { TdhGrantModel } from './tdh-grant.models';
import {
  nftIndexerClient,
  NftIndexerClient
} from '../api-serverless/src/nft-indexer-client/nft-indexer-client';
import { ExternalTokenOwnerEntity } from '../entities/IExternalTokenOwner';
import { randomUUID } from 'crypto';
import {
  externalOwnersRepository,
  ExternalOwnersRepository
} from '../external-owners/external-owners.repository';

export class ApproveOrDenyTdhGrantInQueueUseCase {
  private readonly logger = Logger.get(this.constructor.name);

  constructor(
    private readonly tdhGrantsFinder: TdhGrantsFinder,
    private readonly nftIndexerClient: NftIndexerClient,
    private readonly externalOwnersRepository: ExternalOwnersRepository
  ) {}

  public async handle(ctx: RequestContext) {
    this.logger.info(
      `Checking if there are any pending TDH grants in the queue`
    );
    ctx.timer?.start(`${this.constructor.name}->handle`);
    try {
      await this.externalOwnersRepository.executeNativeQueriesInTransaction(
        async (connection) => {
          const ctxWithConnection = { ...ctx, connection };
          const grantCandidate =
            await this.tdhGrantsFinder.findAndLockPendingLiveTailingGrantAndMarkFailedSnapshots(
              ctxWithConnection
            );
          if (!grantCandidate) {
            this.logger.info(`No pending TDH grants in the queue`);
          } else {
            // TODO: rate overflow check
            // TODO: check. maybe it's already copied because there are historic grants
            await this.copyOwners(
              grantCandidate,
              grantCandidate.snapshotter_block,
              ctx
            );
            // TODO: help with live tailing to global tailer
            // TODO: mark grant as GRANTED
            throw new Error('not implemented');
          }
        }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->handle`);
    }
    this.logger.info(`TDH grants overview finished`);
  }

  private async copyOwners(
    grantCandidate: TdhGrantModel,
    block: number,
    ctx: RequestContext
  ) {
    const { target_contract, target_chain } = grantCandidate;
    const snapshot = await this.nftIndexerClient.getSnapshot({
      target_contract,
      target_chain,
      block
    });
    // TODO: tokens crosscheck
    await this.externalOwnersRepository.insertBatch(
      snapshot.map<ExternalTokenOwnerEntity>((snapshot) => ({
        id: randomUUID(),
        chain: grantCandidate.target_chain,
        contract: grantCandidate.target_contract,
        token: snapshot.tokenId,
        owner: snapshot.owner,
        owned_since_block: snapshot.block,
        owned_since_time: snapshot.timestamp,
        amount: 1,
        is_tombstone: snapshot.acquiredAsSale
      })),
      ctx
    );
  }
}

export const approveOrDenyTdhGrantInQueueUseCase =
  new ApproveOrDenyTdhGrantInQueueUseCase(
    tdhGrantsFinder,
    nftIndexerClient,
    externalOwnersRepository
  );
