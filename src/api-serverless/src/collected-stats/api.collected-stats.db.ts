import {
  CONSOLIDATED_OWNERS_BALANCES_TABLE,
  CONSOLIDATED_WALLETS_TDH_TABLE,
  MEMES_CONTRACT,
  MEMES_EXTENDED_DATA_TABLE,
  MEMES_SEASONS_TABLE,
  NFT_OWNERS_TABLE,
  NFTS_TABLE,
  OWNERS_BALANCES_TABLE,
  TDH_BLOCKS_TABLE,
  WALLETS_TDH_TABLE
} from '@/constants';
import { RequestContext } from '@/request.context';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';

type CollectedStatsSeasonDefinitionRow = {
  season_id: number;
  season: string;
  total_cards_in_season: number;
};

type CollectedStatsHeldBalanceRow = {
  season_id: number;
  token_id: number;
  balance: number;
};

type CollectionSummaryRow = {
  boost: number;
  nextgens_held: number;
  gradients_held: number;
};

export class CollectedStatsDb extends LazyDbAccessCompatibleService {
  async getConsolidatedCollectionSummary(
    consolidationKey: string,
    ctx: RequestContext
  ): Promise<CollectionSummaryRow | null> {
    try {
      ctx.timer?.start(
        `${this.constructor.name}->getConsolidatedCollectionSummary`
      );
      return await this.db.oneOrNull<CollectionSummaryRow>(
        `
          SELECT
            COALESCE(t.boost, 1) AS boost,
            COALESCE(o.nextgen_balance, 0) AS nextgens_held,
            COALESCE(o.gradients_balance, 0) AS gradients_held
          FROM ${CONSOLIDATED_OWNERS_BALANCES_TABLE} o
          LEFT JOIN ${CONSOLIDATED_WALLETS_TDH_TABLE} t
            ON t.consolidation_key = o.consolidation_key
           AND t.block = (SELECT MAX(block_number) FROM ${TDH_BLOCKS_TABLE})
          WHERE o.consolidation_key = :consolidationKey
          LIMIT 1
        `,
        { consolidationKey },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(
        `${this.constructor.name}->getConsolidatedCollectionSummary`
      );
    }
  }

  async getWalletCollectionSummary(
    wallet: string,
    ctx: RequestContext
  ): Promise<CollectionSummaryRow | null> {
    try {
      ctx.timer?.start(`${this.constructor.name}->getWalletCollectionSummary`);
      return await this.db.oneOrNull<CollectionSummaryRow>(
        `
          SELECT
            COALESCE(t.boost, 1) AS boost,
            COALESCE(o.nextgen_balance, 0) AS nextgens_held,
            COALESCE(o.gradients_balance, 0) AS gradients_held
          FROM ${OWNERS_BALANCES_TABLE} o
          LEFT JOIN ${WALLETS_TDH_TABLE} t
            ON t.wallet = o.wallet
           AND t.block = (SELECT MAX(block_number) FROM ${TDH_BLOCKS_TABLE})
          WHERE o.wallet = :wallet
          LIMIT 1
        `,
        { wallet },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->getWalletCollectionSummary`);
    }
  }

  async getSeasonDefinitions(
    ctx: RequestContext
  ): Promise<CollectedStatsSeasonDefinitionRow[]> {
    try {
      ctx.timer?.start(`${this.constructor.name}->getSeasonDefinitions`);
      return await this.db.execute<CollectedStatsSeasonDefinitionRow>(
        `
          SELECT
            id AS season_id,
            display AS season,
            count AS total_cards_in_season
          FROM ${MEMES_SEASONS_TABLE}
          ORDER BY id ASC
        `,
        undefined,
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(`${this.constructor.name}->getSeasonDefinitions`);
    }
  }

  async getHeldBalancesBySeasonAndToken(
    wallets: string[],
    ctx: RequestContext
  ): Promise<CollectedStatsHeldBalanceRow[]> {
    try {
      ctx.timer?.start(
        `${this.constructor.name}->getHeldBalancesBySeasonAndToken`
      );

      if (!wallets.length) {
        return [];
      }

      const params: Record<string, string> = {
        memesContract: MEMES_CONTRACT,
        wallet1: wallets[0]
      };
      let walletFilter = 'o.wallet = :wallet1';

      for (let i = 1; i < wallets.length; i++) {
        const key = `wallet${i + 1}`;
        params[key] = wallets[i];
        walletFilter += ` OR o.wallet = :${key}`;
      }

      return await this.db.execute<CollectedStatsHeldBalanceRow>(
        `
          SELECT
            med.season AS season_id,
            med.id AS token_id,
            CAST(SUM(o.balance) AS UNSIGNED) AS balance
          FROM ${MEMES_EXTENDED_DATA_TABLE} med
          INNER JOIN ${NFTS_TABLE} n
            ON n.id = med.id
           AND n.contract = :memesContract
          INNER JOIN ${NFT_OWNERS_TABLE} o
            ON o.token_id = med.id
           AND o.contract = :memesContract
           AND o.balance > 0
          WHERE (${walletFilter})
          GROUP BY med.season, med.id
          ORDER BY med.season ASC, med.id ASC
        `,
        params,
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(
        `${this.constructor.name}->getHeldBalancesBySeasonAndToken`
      );
    }
  }
}

export const collectedStatsDb = new CollectedStatsDb(dbSupplier);
