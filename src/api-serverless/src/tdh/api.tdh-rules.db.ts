import {
  MEMES_CONTRACT,
  MEMES_SEASONS_TABLE,
  NFTS_TABLE,
  TDH_BLOCKS_TABLE
} from '@/constants';
import { MemesSeason } from '@/entities/ISeason';
import { RequestContext } from '@/request.context';
import { dbSupplier, LazyDbAccessCompatibleService } from '@/sql-executor';

export interface TdhRulesSnapshotRow {
  block_number: number;
  block_timestamp: Date;
  eligible_memes_count: number;
}

export class TdhRulesDb extends LazyDbAccessCompatibleService {
  async getLatestCompletedSnapshot(
    ctx: RequestContext
  ): Promise<TdhRulesSnapshotRow | null> {
    const timerName = `${this.constructor.name}->getLatestCompletedSnapshot`;
    try {
      ctx.timer?.start(timerName);
      return await this.db.oneOrNull<TdhRulesSnapshotRow>(
        `
          SELECT
            b.block_number,
            b.timestamp AS block_timestamp,
            (
              SELECT COUNT(*)
              FROM ${NFTS_TABLE} n
              WHERE LOWER(n.contract) = :memesContract
                AND n.mint_date IS NOT NULL
                AND n.mint_date <= DATE_SUB(b.timestamp, INTERVAL 1 DAY)
            ) AS eligible_memes_count
          FROM ${TDH_BLOCKS_TABLE} b
          ORDER BY b.block_number DESC
          LIMIT 1
        `,
        { memesContract: MEMES_CONTRACT.toLowerCase() },
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(timerName);
    }
  }

  async getSeasonDefinitions(ctx: RequestContext): Promise<MemesSeason[]> {
    const timerName = `${this.constructor.name}->getSeasonDefinitions`;
    try {
      ctx.timer?.start(timerName);
      return await this.db.execute<MemesSeason>(
        `
          SELECT id, start_index, end_index, count, name, display, boost
          FROM ${MEMES_SEASONS_TABLE}
          ORDER BY id ASC
        `,
        undefined,
        { wrappedConnection: ctx.connection }
      );
    } finally {
      ctx.timer?.stop(timerName);
    }
  }
}

export const tdhRulesDb = new TdhRulesDb(dbSupplier);
