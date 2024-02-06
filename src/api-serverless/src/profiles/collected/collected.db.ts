import {
  dbSupplier,
  LazyDbAccessCompatibleService
} from '../../../../sql-executor';
import {
  CONSOLIDATED_WALLETS_TDH_TABLE,
  GRADIENT_CONTRACT,
  MEMELAB_CONTRACT,
  MEMES_CONTRACT,
  NFTS_TABLE,
  OWNERS_MEME_LAB_TABLE,
  TDH_BLOCKS_TABLE,
  WALLETS_TDH_TABLE
} from '../../../../constants';
import { CollectionType } from './collected.types';

export class CollectedDb extends LazyDbAccessCompatibleService {
  async getAllNfts(): Promise<NftData[]> {
    return await this.db.execute(
      `
    select if(contract = '${MEMES_CONTRACT}', 'MEMES', 'GRADIENTS') as collection,
                    id as token_id,
                    name,
                    trim(regexp_substr(description, '(?<=Season: )(.*)(?=\\n)')) as season,
                    thumbnail
             from ${NFTS_TABLE}
             where contract in
                   ('${MEMES_CONTRACT}', '${GRADIENT_CONTRACT}')
             union all
             select 'MEMELAB' as collection,
                    id        as token_id,
                    name,
                    null      as season,
                    thumbnail
             from nfts_meme_lab
             where contract = '${MEMELAB_CONTRACT}'
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
       from owners
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
  ): Promise<NftsOwnershipData> {
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
  ): Promise<NftsOwnershipData> {
    return await this.db
      .execute(
        `
      select
          boost, memes, memes_ranks, gradients, gradients_ranks
      from ${CONSOLIDATED_WALLETS_TDH_TABLE} where lower(consolidation_key) like concat('%', lower(:wallet), '%')
    `,
        { wallet }
      )
      .then(this.mapMemesAndGradientsResults);
  }

  async getWalletsMemeLabsBalancesByTokens(
    wallets: string[]
  ): Promise<Record<number, number>> {
    if (wallets.length === 0) {
      return {};
    }
    const params: Record<string, string> = { wallet1: wallets[0] };
    let sql = `select token_id, sum(balance) as balance from ${OWNERS_MEME_LAB_TABLE} where contract = '${MEMELAB_CONTRACT}' and (lower(wallet) like concat('%', lower(:wallet1), '%')`;
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

  private mapMemesAndGradientsResults(res: any[]): NftsOwnershipData {
    if (res.length === 0) {
      return { memes: {}, memes_ranks: {}, gradients: {}, gradients_ranks: {} };
    }
    return {
      memes: JSON.parse(res[0].memes).reduce(
        (acc: Record<number, { tdh: number; balance: number }>, cur: any) => {
          acc[cur.id] = { tdh: cur.tdh * res[0].boost, balance: cur.balance };
          return acc;
        },
        {} as Record<number, { tdh: number; balance: number }>
      ),
      memes_ranks: JSON.parse(res[0].memes_ranks).reduce(
        (acc: Record<number, number>, cur: any) => {
          acc[cur.id] = cur.rank;
          return acc;
        },
        {} as Record<number, number>
      ),
      gradients: JSON.parse(res[0].gradients).reduce(
        (acc: Record<number, { tdh: number; balance: number }>, cur: any) => {
          acc[cur.id] = { tdh: cur.tdh * res[0].boost, balance: cur.balance };
          return acc;
        },
        {} as Record<number, { tdh: number; balance: number }>
      ),
      gradients_ranks: JSON.parse(res[0].gradients_ranks).reduce(
        (acc: Record<number, number>, cur: any) => {
          acc[cur.id] = cur.rank;
          return acc;
        },
        {} as Record<number, number>
      )
    };
  }
}

export interface NftData {
  collection: CollectionType;
  token_id: number;
  name: string;
  season: number;
  thumbnail: string;
}

export interface NftsOwnershipData {
  memes: CollectionTokensTdhAndBalance;
  memes_ranks: Record<number, number>;
  gradients: CollectionTokensTdhAndBalance;
  gradients_ranks: Record<number, number>;
}

export interface TokenTdhAndBalance {
  tdh: number;
  balance: number;
}

export type CollectionTokensTdhAndBalance = Record<number, TokenTdhAndBalance>;

export const collectedDb = new CollectedDb(dbSupplier);
