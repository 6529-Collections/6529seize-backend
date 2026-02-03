import {
  ADDRESS_CONSOLIDATION_KEY,
  CONSOLIDATED_WALLETS_TDH_TABLE,
  GRADIENT_CONTRACT,
  MEMELAB_CONTRACT,
  MEMES_CONTRACT,
  NFT_OWNERS_TABLE,
  NFTS_TABLE,
  TDH_BLOCKS_TABLE,
  WALLETS_TDH_TABLE
} from '@/constants';
import {
  NEXTGEN_TOKENS_TABLE,
  NEXTGEN_TOKENS_TDH_TABLE
} from '../../../../nextgen/nextgen_constants';
import {
  dbSupplier,
  LazyDbAccessCompatibleService
} from '../../../../sql-executor';
import { CollectionType } from './collected.types';

export class CollectedDb extends LazyDbAccessCompatibleService {
  async getAllNfts(): Promise<NftData[]> {
    return await this.db.execute(
      `
        SELECT 
          CAST(IF(n.contract = '${MEMES_CONTRACT}', '${CollectionType.MEMES}', '${CollectionType.GRADIENTS}') AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci AS collection,
          n.id AS token_id,
          CAST(n.name AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci AS name,
          CAST(jt.value AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci AS season,
          n.thumbnail
        FROM ${NFTS_TABLE} n
        LEFT JOIN JSON_TABLE(
          n.metadata,
          '$.attributes[*]' COLUMNS (
            trait_type VARCHAR(255) PATH '$.trait_type',
            value VARCHAR(255) PATH '$.value'
          )
        ) AS jt ON jt.trait_type = 'Type - Season'
        WHERE n.contract IN ('${MEMES_CONTRACT}', '${GRADIENT_CONTRACT}')

        UNION ALL

        SELECT 
          CAST('${CollectionType.MEMELAB}' AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci AS collection,
          id AS token_id,
          CAST(name AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci AS name,
          CAST(NULL AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci AS season,
          thumbnail
        FROM nfts_meme_lab
        WHERE contract = '${MEMELAB_CONTRACT}'

        UNION ALL

        SELECT 
          CAST('${CollectionType.NEXTGEN}' AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci AS collection,
          token.id AS token_id,
          CAST(token.name AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci AS name,
          CAST(token.collection_name AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci AS season,
          COALESCE(token.thumbnail_url, token.image_url) AS thumbnail
        FROM nextgen_tokens token
      `
    );
  }

  async getGradientsAndMemesLiveBalancesByTokenIds(wallets: string[]): Promise<{
    gradients: Record<number, number>;
    memes: Record<number, number>;
  }> {
    if (!wallets.length) {
      return {
        gradients: {},
        memes: {}
      };
    }
    let sql = `select 
       token_id,
       case when contract = '${MEMES_CONTRACT}' then '${CollectionType.MEMES}' else '${CollectionType.GRADIENTS}' end collection,
       sum(balance) as balance
       from ${NFT_OWNERS_TABLE}
       where contract in ('${MEMES_CONTRACT}', '${GRADIENT_CONTRACT}') and (lower(wallet) = lower(:wallet1)`;

    const params: Record<string, string> = { wallet1: wallets[0] };

    for (let i = 1; i < wallets.length; i++) {
      const key = `wallet${i + 1}`;
      params[key] = wallets[i];
      sql += ` or lower(wallet) = lower(:${key})`;
    }
    sql += `) group by token_id, collection`;
    const result: {
      token_id: number;
      collection: CollectionType;
      balance: number;
    }[] = await this.db.execute(sql, params);
    return result.reduce(
      (acc, cur) => {
        if (cur.collection === CollectionType.MEMES) {
          acc.memes[cur.token_id] = cur.balance;
        } else {
          acc.gradients[cur.token_id] = cur.balance;
        }
        return acc;
      },
      {
        gradients: {} as Record<number, number>,
        memes: {} as Record<number, number>
      }
    );
  }

  async getWalletMemesAndGradientsMetrics(
    wallet: string
  ): Promise<MemesAndGradientsOwnershipData> {
    return await this.db
      .execute(
        `select
          boost, memes, memes_ranks, gradients, gradients_ranks
      from ${WALLETS_TDH_TABLE} where lower(wallet) = :wallet and block = (select max(block_number) from ${TDH_BLOCKS_TABLE})`,
        { wallet: wallet.toLowerCase() }
      )
      .then(this.mapMemesAndGradientsResults);
  }

  async getWalletConsolidatedMemesAndGradientsMetrics(
    wallet: string
  ): Promise<MemesAndGradientsOwnershipData> {
    return await this.db
      .execute(
        `
      select
          t.boost, t.memes, t.memes_ranks, t.gradients, t.gradients_ranks
      from ${ADDRESS_CONSOLIDATION_KEY} c
      join ${CONSOLIDATED_WALLETS_TDH_TABLE} t on t.consolidation_key = c.consolidation_key
      where  c.address = :wallet
    `,
        { wallet }
      )
      .then(this.mapMemesAndGradientsResults);
  }

  async getNextgenLiveBalances(
    wallets: string[]
  ): Promise<Record<number, number>> {
    if (!wallets.length) {
      return {};
    }
    let sql = `select id from ${NEXTGEN_TOKENS_TABLE} where owner = lower(:wallet1)`;
    const params: Record<string, string> = { wallet1: wallets[0] };
    for (let i = 1; i < wallets.length; i++) {
      const key = `wallet${i + 1}`;
      params[key] = wallets[i];
      sql += ` or owner = lower(:${key})`;
    }
    const result: { id: number }[] = await this.db.execute(sql, params);
    return result.reduce(
      (acc, cur) => {
        acc[cur.id] = 1;
        return acc;
      },
      {} as Record<number, number>
    );
  }

  async getWalletsMemeLabsBalancesByTokens(
    wallets: string[]
  ): Promise<Record<number, number>> {
    if (wallets.length === 0) {
      return {};
    }
    const params: Record<string, string> = { wallet1: wallets[0] };
    let sql = `select token_id, sum(balance) as balance from ${NFT_OWNERS_TABLE} where contract = '${MEMELAB_CONTRACT}' and (lower(wallet) like concat('%', lower(:wallet1), '%')`;
    for (let i = 1; i < wallets.length; i++) {
      const key = `wallet${i + 1}`;
      params[key] = wallets[i];
      sql += ` or lower(wallet) like concat('%', lower(:${key}), '%')`;
    }
    sql += `) group by token_id`;
    return await this.db.execute(sql, params).then((result) =>
      result.reduce(
        (
          acc: Record<number, number>,
          cur: { token_id: number; balance: number }
        ) => {
          acc[cur.token_id] = cur.balance;
          return acc;
        },
        {} as Record<number, number>
      )
    );
  }

  private mapMemesAndGradientsResults(
    res: any[]
  ): MemesAndGradientsOwnershipData {
    if (res.length === 0) {
      return {
        memes: {
          ranks: {},
          tdhsAndBalances: {}
        },
        gradients: {
          ranks: {},
          tdhsAndBalances: {}
        }
      };
    }
    return {
      memes: {
        tdhsAndBalances: JSON.parse(res[0].memes).reduce(
          (acc: Record<number, { tdh: number; balance: number }>, cur: any) => {
            acc[cur.id] = { tdh: cur.tdh * res[0].boost, balance: cur.balance };
            return acc;
          },
          {} as Record<number, { tdh: number; balance: number }>
        ),
        ranks: JSON.parse(res[0].memes_ranks).reduce(
          (acc: Record<number, number>, cur: any) => {
            acc[cur.id] = cur.rank;
            return acc;
          },
          {} as Record<number, number>
        )
      },
      gradients: {
        tdhsAndBalances: JSON.parse(res[0].gradients).reduce(
          (acc: Record<number, { tdh: number; balance: number }>, cur: any) => {
            acc[cur.id] = { tdh: cur.tdh * res[0].boost, balance: cur.balance };
            return acc;
          },
          {} as Record<number, { tdh: number; balance: number }>
        ),
        ranks: JSON.parse(res[0].gradients_ranks).reduce(
          (acc: Record<number, number>, cur: any) => {
            acc[cur.id] = cur.rank;
            return acc;
          },
          {} as Record<number, number>
        )
      }
    };
  }

  async getConsolidatedNextgenMetrics(
    wallets: string[]
  ): Promise<NftsCollectionOwnershipData> {
    if (!wallets?.length) {
      return {
        tdhsAndBalances: {},
        ranks: {}
      };
    }
    let sql = `select
        token.id as token_id,
        ifnull(tdh.boosted_tdh, 0) as tdh,
        ifnull(tdh.tdh_rank, 0.0) as \`rank\`,
        1 as seized_count
    from ${NEXTGEN_TOKENS_TABLE} token
             left join ${NEXTGEN_TOKENS_TDH_TABLE} tdh on token.id = tdh.id
    where lower(token.owner) = lower(:wallet1)`;
    const params: Record<string, string> = { wallet1: wallets[0] };
    for (let i = 1; i < wallets.length; i++) {
      const key = `wallet${i + 1}`;
      params[key] = wallets[i];
      sql += ` or lower(token.owner) = lower(:${key})`;
    }
    const result: {
      token_id: number;
      tdh: number;
      rank: number;
      seized_count: number;
    }[] = await this.db.execute(sql, params);
    return {
      tdhsAndBalances: result.reduce(
        (acc, cur) => {
          acc[cur.token_id] = { tdh: cur.tdh, balance: cur.seized_count };
          return acc;
        },
        {} as Record<number, { tdh: number; balance: number }>
      ),
      ranks: result.reduce(
        (acc, cur) => {
          acc[cur.token_id] = cur.rank;
          return acc;
        },
        {} as Record<number, number>
      )
    };
  }

  async getWalletNextgenMetrics(
    wallet: string
  ): Promise<NftsCollectionOwnershipData> {
    return this.db
      .execute(
        `select nextgen, nextgen_ranks, boost from ${WALLETS_TDH_TABLE} where block = (select max(block_number) from ${TDH_BLOCKS_TABLE}) and lower(wallet) = lower(:wallet)`,
        { wallet }
      )
      .then((result) => {
        if (result.length === 0) {
          return {
            tdhsAndBalances: {},
            ranks: {}
          };
        } else {
          return {
            tdhsAndBalances: JSON.parse(result[0].nextgen).reduce(
              (
                acc: Record<number, { tdh: number; balance: number }>,
                cur: any
              ) => {
                acc[cur.id] = {
                  tdh: (cur.tdh ?? 0) * (result[0].boost ?? 1),
                  balance: cur.balance
                };
                return acc;
              },
              {} as Record<number, { tdh: number; balance: number }>
            ),
            ranks: JSON.parse(result[0].nextgen_ranks).reduce(
              (acc: Record<number, number>, cur: any) => {
                acc[cur.id] = cur.rank;
                return acc;
              },
              {} as Record<number, number>
            )
          };
        }
      });
  }
}

export interface NftData {
  collection: CollectionType;
  token_id: number;
  name: string;
  season: string;
  thumbnail: string;
}

export interface MemesAndGradientsOwnershipData {
  memes: NftsCollectionOwnershipData;
  gradients: NftsCollectionOwnershipData;
}

export interface NftsCollectionOwnershipData {
  tdhsAndBalances: Record<number, { tdh: number; balance: number }>;
  ranks: Record<number, number>;
}

export interface TokenTdhAndBalance {
  tdh: number;
  balance: number;
}

export type CollectionTokensTdhAndBalance = Record<number, TokenTdhAndBalance>;

export const collectedDb = new CollectedDb(dbSupplier);
