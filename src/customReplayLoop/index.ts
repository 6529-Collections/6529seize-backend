import { MEMES_CONTRACT, NFTS_TABLE } from '@/constants';
import { MemesMintStat } from '@/entities/IMemesMintStat';
import { upsertMemesMintStats } from '@/memes-mint-stats/memes-mint-stats';
import { Logger } from '@/logging';
import * as sentryContext from '@/sentry.context';
import { doInDbContext } from '@/secrets';
import { sqlExecutor } from '@/sql-executor';

const logger = Logger.get('CUSTOM_REPLAY_LOOP');

type ReplayMemeRow = {
  id: number;
  mint_date: Date | string;
};

export const handler = sentryContext.wrapLambdaHandler(async () => {
  await doInDbContext(
    async () => {
      await replay();
    },
    {
      entities: [MemesMintStat],
      logger
    }
  );
});

async function replay() {
  logger.info(`[MEMES MINT STATS REPLAY START]`);

  const memes = await sqlExecutor.execute<ReplayMemeRow>(
    `SELECT id, mint_date
    FROM ${NFTS_TABLE}
    WHERE contract = '${MEMES_CONTRACT}'
      AND mint_date IS NOT NULL
    ORDER BY id ASC`
  );

  for (const meme of memes) {
    const mintDate = new Date(meme.mint_date);
    if (Number.isNaN(mintDate.getTime())) {
      logger.warn(
        `[MEMES MINT STATS REPLAY SKIP] [id=${meme.id}] [invalid_mint_date=${meme.mint_date}]`
      );
      continue;
    }

    const payload = await upsertMemesMintStats(meme.id, mintDate);
    if (!payload) {
      logger.info(
        `[MEMES MINT STATS REPLAY SKIP] [id=${meme.id}] [reason=stats_row_missing]`
      );
      continue;
    }
    logger.info(
      `[MEMES MINT STATS REPLAY UPSERT] [id=${meme.id}] [total_count=${payload.total_count}] [mint_count=${payload.mint_count}] [subscriptions_count=${payload.subscriptions_count}]`
    );
  }

  logger.info(`[MEMES MINT STATS REPLAY DONE] [count=${memes.length}]`);
}
