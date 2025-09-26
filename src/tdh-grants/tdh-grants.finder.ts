import {
  tdhGrantsRepository,
  TdhGrantsRepository
} from './tdh-grants.repository';
import { RequestContext } from '../request.context';
import { fromTdhGrantEntityToModel, TdhGrantModel } from './tdh-grant.models';
import { TdhGrantStatus } from '../entities/ITdhGrant';
import {
  nftIndexerClient,
  NftIndexerClient
} from '../api-serverless/src/nft-indexer-client/nft-indexer-client';
import { Logger } from '../logging';

export class TdhGrantsFinder {
  private readonly logger = Logger.get(TdhGrantsFinder.name);
  constructor(
    private readonly tdhGrantsRepository: TdhGrantsRepository,
    private readonly nftIndexerClient: NftIndexerClient
  ) {}

  public async searchForPage(
    {
      grantor_id,
      target_contract,
      target_chain,
      status,
      sort_direction,
      sort,
      page,
      page_size
    }: {
      readonly grantor_id: string | null;
      readonly target_contract: string | null;
      readonly target_chain: number | null;
      readonly status: TdhGrantStatus | null;
      readonly sort_direction: 'ASC' | 'DESC' | null;
      readonly sort:
        | 'created_at'
        | 'valid_from'
        | 'valid_to'
        | 'tdh_rate'
        | null;
      readonly page: number;
      readonly page_size: number;
    },
    ctx: RequestContext
  ): Promise<{
    count: number;
    items: TdhGrantModel[];
    next: boolean;
    page: number;
  }> {
    try {
      ctx.timer?.start(`${this.constructor.name}->searchForPage`);
      const limit = page_size;
      const offset = page_size * (page - 1);
      const [items, count] = await Promise.all([
        this.tdhGrantsRepository
          .getPageItems(
            {
              grantor_id,
              target_contract,
              target_chain,
              status,
              sort_direction,
              sort,
              limit,
              offset
            },
            ctx
          )
          .then((dbResults) =>
            dbResults.map((entity) => fromTdhGrantEntityToModel(entity))
          ),
        this.tdhGrantsRepository.countItems(
          {
            grantor_id,
            target_contract,
            target_chain,
            status
          },
          ctx
        )
      ]);
      return {
        items,
        count,
        page,
        next: count > page_size * page
      };
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->searchForPage`);
    }
  }

  public async findAndLockPendingLiveTailingGrantAndMarkFailedSnapshots(
    ctx: RequestContext
  ): Promise<(TdhGrantModel & { snapshotter_block: number }) | null> {
    ctx.timer?.start(`${this.constructor.name}->findAndLockPendingGrant`);
    try {
      for (let offset = 0; ; offset++) {
        const grant = await this.tdhGrantsRepository.lockOldestPendingGrant(
          offset,
          ctx
        );
        if (!grant) {
          this.logger.info(`No pending grants found`);
          return null;
        }
        const { target_contract, target_chain } = grant;
        const status = await this.nftIndexerClient.getContractStatus({
          chain: target_chain,
          contract: target_contract
        });
        if (status.status === 'LIVE_TAILING') {
          this.logger.info(
            `Found a PENDING grant ${grant.id} for ${target_chain}/${target_contract} and indexer is in LIVE_TAILING status`
          );
          const snapshotter_block = status.safe_head_block;
          if (!snapshotter_block) {
            throw new Error(
              `Something is wrong. ${target_chain}/${target_contract} is in LIVE_TAILING, but it's missing a safe_head_block`
            );
          }
          return { ...fromTdhGrantEntityToModel(grant), snapshotter_block };
        }
        let error = status.error;
        if (!error) {
          if (status.status === 'UNINDEXABLE') {
            error = 'Contract is not indexable';
          }
        }
        if (error) {
          await this.tdhGrantsRepository.updateStatus(
            {
              grantId: grant.id,
              status: TdhGrantStatus.FAILED,
              error
            },
            ctx
          );
          this.logger.warn(
            `Found a failed snapshot for grant ${grant.id} for ${target_chain}/${target_contract}. Error: ${error}`
          );
        }
        this.logger.info(
          `Found a PENDING grant ${grant.id} for ${target_chain}/${target_contract}, but the indexer is in status: ${status.status}`
        );
      }
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->findAndLockPendingGrant`);
    }
  }
}

export const tdhGrantsFinder = new TdhGrantsFinder(
  tdhGrantsRepository,
  nftIndexerClient
);
