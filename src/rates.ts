import { RATE_EVENTS_TABLE, RATE_MATTERS_CATEGORIES_TABLE } from './constants';
import { ConnectionWrapper, sqlExecutor } from './sql-executor';

import { randomUUID } from 'crypto';
import {
  RateCategoryMedia,
  RateMatterCategory,
  RateMatterTargetType
} from './entities/IRateMatter';
import { RateEvent, RateEventReason } from './entities/IRateEvent';
import { Time } from './time';
import { BadRequestException } from './exceptions';
import * as tdh_consolidation from './tdh_consolidation';
import { Logger } from './logging';

const logger = Logger.get('RATES');

async function getCategoriesForMatter({
  matter,
  matterTargetType
}: {
  matter: string;
  matterTargetType: RateMatterTargetType;
}): Promise<RateMatterCategory[]> {
  return sqlExecutor.execute(
    `SELECT * FROM ${RATE_MATTERS_CATEGORIES_TABLE} 
    WHERE matter_target_type = :matterTargetType 
    AND matter = :matter`,
    { matterTargetType, matter }
  );
}

async function insertRateEvent(
  event: RateEvent,
  connectionHolder?: ConnectionWrapper<any>
) {
  await sqlExecutor.execute(
    `INSERT INTO ${RATE_EVENTS_TABLE} (id,
                                       rater,
                                       matter_target_id,
                                       matter_target_type,
                                       matter,
                                       matter_category,
                                       event_reason,
                                       amount,
                                       created_time)
     values (:id,
             :rater,
             :matterTargetId,
             :matterTargetType,
             :matter,
             :matterCategory,
             :eventReason,
             :amount,
             current_time)`,
    {
      id: event.id,
      rater: event.rater,
      matterTargetId: event.matter_target_id,
      matterTargetType: event.matter_target_type,
      matter: event.matter,
      matterCategory: event.matter_category,
      eventReason: event.event_reason,
      amount: event.amount
    },
    { wrappedConnection: connectionHolder?.connection }
  );
}

export async function registerUserRating({
  rater,
  matter,
  matterTargetType,
  matterTargetId,
  category,
  amount
}: {
  rater: string;
  matter: string;
  matterTargetType: RateMatterTargetType;
  matterTargetId: string;
  category: string;
  amount: number;
}) {
  const { ratesLeft, consolidatedWallets } =
    await getRatesLeftOnMatterForWallet({
      wallet: rater,
      matter,
      matterTargetType
    });
  const ratesTallyForWalletOnMatterByCategories =
    await getRatesTallyForWalletOnMatterByCategories({
      matter,
      matterTargetType,
      matterTargetId,
      wallets: consolidatedWallets
    });
  const ratesSpentOnGivenCategory =
    ratesTallyForWalletOnMatterByCategories[category] ?? 0;
  if (amount === 0) {
    return;
  }
  if (amount < 0 && Math.abs(amount) > ratesSpentOnGivenCategory) {
    throw new BadRequestException(
      `Wallet tried to revoke ${amount} rates on matter and category but has only historically given ${ratesSpentOnGivenCategory} rates`
    );
  }
  if (amount > 0 && ratesLeft < amount) {
    throw new BadRequestException(
      `Wallet tried to give ${amount} rates on matter without enough rates left. Rates left: ${ratesLeft}`
    );
  }
  const allCategoriesForMatter = await getCategoriesForMatter({
    matter,
    matterTargetType
  });
  const activeCategory = allCategoriesForMatter
    .filter((c) => !c.disabled_time)
    .filter((c) => c.matter === matter)
    .filter((c) => c.matter_target_type === matterTargetType)
    .find((c) => c.matter_category_tag === category);
  if (!activeCategory) {
    throw new BadRequestException(
      `Tried to rate on matter with category ${category} but no active category with such tag exists for this matter`
    );
  }
  await insertRateEvent({
    id: randomUUID(),
    rater,
    matter_target_id: matterTargetId,
    matter_target_type: matterTargetType,
    matter,
    matter_category: category,
    event_reason: RateEventReason.USER_RATED,
    amount,
    created_time: new Date()
  });
}

export async function getRatesLeftOnMatterForWallet({
  wallet,
  matter,
  matterTargetType
}: {
  wallet: string;
  matter: string;
  matterTargetType: RateMatterTargetType;
}): Promise<{
  ratesLeft: number;
  ratesSpent: number;
  consolidatedWallets: string[];
}> {
  const { tdh, consolidatedWallets } =
    await tdh_consolidation.getWalletTdhAndConsolidatedWallets(wallet);
  if (
    !consolidatedWallets.find((w) => w.toLowerCase() === wallet.toLowerCase())
  ) {
    consolidatedWallets.push(wallet.toLowerCase());
  }
  const ratesSpent = await getTotalRatesSpentOnMatterByWallets({
    wallets: consolidatedWallets,
    matter,
    matterTargetType
  });
  return {
    ratesLeft: tdh - ratesSpent,
    ratesSpent: ratesSpent,
    consolidatedWallets
  };
}

async function getRatesTallyForWalletOnMatterByCategories({
  wallets,
  matter,
  matterTargetType,
  matterTargetId
}: {
  wallets: string[];
  matter: string;
  matterTargetType: RateMatterTargetType;
  matterTargetId: string;
}): Promise<Record<string, number>> {
  if (!wallets.length) {
    return {};
  }
  const result: { matter_category: string; rate_tally: number }[] =
    await sqlExecutor.execute(
      `SELECT matter_category, SUM(amount) AS rate_tally FROM ${RATE_EVENTS_TABLE}
      WHERE LOWER(rater) IN (:wallets)
      AND matter = :matter
      AND matter_target_type = :matterTargetType
      AND matter_target_id = :matterTargetId
      GROUP BY matter_category`,
      {
        wallets: wallets.map((it) => it.toLowerCase()),
        matter,
        matterTargetType,
        matterTargetId
      }
    );
  return (result ?? []).reduce((acc, row) => {
    acc[row.matter_category] = row.rate_tally;
    return acc;
  }, {} as Record<string, number>);
}

export interface RateCategoryInfo {
  category_tag: string;
  tally: number;
  category_display_name: string;
  category_media: RateCategoryMedia;
  category_enabled: boolean;
  authenticated_wallet_rates: number;
}

async function getTotalTalliesByCategories(
  matterTargetType: RateMatterTargetType,
  matterTargetId: string,
  matter: string
): Promise<Record<string, number>> {
  const totalTallies: {
    matter_category: string;
    rate_tally: number;
  }[] = await sqlExecutor.execute(
    `SELECT matter_category, SUM(amount) AS rate_tally FROM ${RATE_EVENTS_TABLE}
    WHERE matter_target_type = :matterTargetType
    AND matter_target_id = :matterTargetId
    AND matter = :matter
    GROUP BY matter, matter_category`,
    { matterTargetType, matterTargetId, matter }
  );
  return totalTallies.reduce((acc, row) => {
    acc[row.matter_category] = row.rate_tally;
    return acc;
  }, {} as Record<string, number>);
}

export async function getCategoriesInfoOnMatter({
  matterTargetType,
  matterTargetId,
  matter,
  wallets
}: {
  wallets: string[];
  matterTargetType: RateMatterTargetType;
  matter: string;
  matterTargetId: string;
}): Promise<RateCategoryInfo[]> {
  const categories = await getCategoriesForMatter({
    matter,
    matterTargetType
  });
  const totalTalliesByCategory = await getTotalTalliesByCategories(
    matterTargetType,
    matterTargetId,
    matter
  );
  const walletsRatesByCategory =
    await getRatesTallyForWalletOnMatterByCategories({
      wallets,
      matter,
      matterTargetType,
      matterTargetId
    });
  return categories.map<RateCategoryInfo>((c) => ({
    tally: totalTalliesByCategory[c.matter_category_tag] ?? 0,
    authenticated_wallet_rates:
      walletsRatesByCategory[c.matter_category_tag] ?? 0,
    category_tag: c.matter_category_tag,
    category_enabled: !c.disabled_time,
    category_display_name: c.matter_category_display_name,
    category_media: JSON.parse(c.matter_category_media || '{}')
  }));
}

function calculateOverrateSummaries(
  activeTdhs: {
    tdh: number;
    wallets: string[];
  }[],
  talliesByWallets: Record<
    string,
    Record<
      string,
      { matter: string; matter_target_type: string; tally: number }
    >
  >
) {
  // create mock 0 tdhs for wallets that have historically rated but are not part of community anymore
  for (const wallet of Object.keys(talliesByWallets)) {
    const walletNotFoundFromTdhs = !activeTdhs.find((tdh) =>
      tdh.wallets.map((it) => it.toLowerCase()).includes(wallet.toLowerCase())
    );
    if (walletNotFoundFromTdhs) {
      activeTdhs.push({
        tdh: 0,
        wallets: [wallet]
      });
    }
  }
  return activeTdhs.reduce(
    (aggregatedTallies, activeTdh) => {
      const talliesForConsolidationGroupsByMatter: Record<
        string,
        {
          tally: number;
          matter: string;
          matter_target_type: string;
          rate_participating_wallets: string[];
          tdh: number;
        }
      > = {};
      // aggregate all consolidation group rates by matter
      for (const wallet of activeTdh.wallets) {
        const allMattersTalliesForWallet = talliesByWallets[wallet] || {};
        for (const [key, matterTallyDescription] of Object.entries(
          allMattersTalliesForWallet
        )) {
          if (!talliesForConsolidationGroupsByMatter[key]) {
            // for the first wallet in consolidation group that has spent rates on this matter
            talliesForConsolidationGroupsByMatter[key] = {
              matter: matterTallyDescription.matter,
              matter_target_type: matterTallyDescription.matter_target_type,
              tally: matterTallyDescription.tally,
              rate_participating_wallets: [wallet],
              tdh: activeTdh.tdh
            };
          } else {
            // for other wallets in consolidation group that has spent rates on this matter
            talliesForConsolidationGroupsByMatter[key] = {
              matter: matterTallyDescription.matter,
              matter_target_type: matterTallyDescription.matter_target_type,
              tally:
                talliesForConsolidationGroupsByMatter[key].tally +
                matterTallyDescription.tally,
              rate_participating_wallets: [
                wallet,
                ...talliesForConsolidationGroupsByMatter[key]
                  .rate_participating_wallets
              ],
              tdh: activeTdh.tdh
            };
          }
        }
      }
      // keep only the ones where rate count exceeds TDH
      aggregatedTallies.push(
        ...Object.values(talliesForConsolidationGroupsByMatter).filter(
          (t) => t.tally > activeTdh.tdh
        )
      );
      return aggregatedTallies;
    },
    [] as {
      tdh: number;
      tally: number;
      matter: string;
      matter_target_type: string;
      rate_participating_wallets: string[];
    }[]
  );
}

async function getAllRateMatterTalliesByWallets() {
  const activeRateTally: {
    rater: string;
    matter: string;
    matter_target_type: RateMatterTargetType;
    rate_tally: number;
  }[] = await sqlExecutor.execute(
    `select rater, matter, matter_target_type, sum(amount) as rate_tally from ${RATE_EVENTS_TABLE} group by rater, matter, matter_target_type`
  );
  return activeRateTally.reduce((a, vt) => {
    const rater = vt.rater.toLowerCase();
    if (!a[rater]) {
      a[rater] = {};
    }
    a[rater][`${vt.matter}-${vt.matter_target_type}`] = {
      matter: vt.matter,
      matter_target_type: vt.matter_target_type,
      tally: +vt.rate_tally
    };
    return a;
  }, {} as Record<string, Record<string, { matter: string; matter_target_type: string; tally: number }>>);
}

async function createRevocationEvents(
  allOverRates: {
    tdh: number;
    tally: number;
    matter: string;
    matter_target_type: string;
    rate_participating_wallets: string[];
  }[]
) {
  await sqlExecutor.executeNativeQueriesInTransaction(
    async (connectionHolder) => {
      for (const overRate of allOverRates) {
        const overRateAmount = overRate.tally - overRate.tdh;

        const toBeRevokedEvents: RateEvent[] = await sqlExecutor.execute(
          `WITH full_overrates AS (SELECT NULL AS id, NULL AS total
                               FROM dual
                               WHERE (@total := 0)
                               UNION
                               SELECT ve.id, @total := @total + ve.amount AS total
                               FROM (SELECT id, amount
                                     FROM rate_events
                                     WHERE LOWER(rater) IN (:rateParticipantsIn)
                                       AND matter = :matter
                                     ORDER BY created_time desc) ve
                               WHERE @total < :overRateAmount)
       SELECT *
       FROM rate_events
       WHERE id IN (SELECT id FROM full_overrates)
       ORDER BY created_time DESC`,
          {
            matter: overRate.matter,
            overRateAmount: overRateAmount,
            rateParticipantsIn: overRate.rate_participating_wallets.map((it) =>
              it.toLowerCase()
            )
          },
          { wrappedConnection: connectionHolder }
        );
        const reverseRateEventsByKey: Record<string, RateEvent> = {};
        let reverseRateAmount = 0;
        for (const event of toBeRevokedEvents) {
          const key = `${event.matter}-${event.matter_target_type}-${event.rater}-${event.matter_target_id}-${event.matter_category}`;
          let toAdd = event.amount;
          if (reverseRateAmount + toAdd > overRateAmount) {
            toAdd = overRateAmount - reverseRateAmount;
          }
          reverseRateAmount += toAdd;
          if (!reverseRateEventsByKey[key]) {
            reverseRateEventsByKey[key] = {
              ...event,
              id: randomUUID(),
              created_time: new Date(),
              event_reason: RateEventReason.TDH_CHANGED,
              amount: -toAdd
            };
          } else {
            reverseRateEventsByKey[key].amount -= toAdd;
          }
        }
        const reverseRateEvents = Object.values(reverseRateEventsByKey).filter(
          (e) => e.amount !== 0
        );
        for (const reverseRaterEvent of reverseRateEvents) {
          await insertRateEvent(reverseRaterEvent, connectionHolder);
        }
        logger.info(
          `Created ${reverseRateEvents.length} rate revocation events on matter ${overRate.matter_target_type}/${overRate.matter}`
        );
      }
    }
  );
}

export async function revokeOverRates() {
  const startTime = Time.now();
  logger.info(`Fetching current TDH's...`);
  const activeTdhs = await tdh_consolidation.getAllTdhs();
  logger.info(`Fetching current rate tallies...`);
  const talliesByWallets = await getAllRateMatterTalliesByWallets();
  logger.info(`Figuring out overrates...`);
  const allOverRates = calculateOverrateSummaries(activeTdhs, talliesByWallets);
  logger.info(`Revoking overrates...`);
  await createRevocationEvents(allOverRates);
  logger.info(`All overrates revoked in ${startTime.diffFromNow()}`);
}

async function getTotalRatesSpentOnMatterByWallets({
  wallets,
  matter,
  matterTargetType
}: {
  wallets: string[];
  matter: string;
  matterTargetType: RateMatterTargetType;
}): Promise<number> {
  if (!wallets.length) {
    return 0;
  }
  const result: { rates_spent: number }[] = await sqlExecutor.execute(
    `SELECT SUM(amount) AS rates_spent FROM ${RATE_EVENTS_TABLE}
     WHERE LOWER(rater) IN (:wallets) 
     AND matter = :matter 
     AND matter_target_type = :matterTargetType`,
    { matter, matterTargetType, wallets: wallets.map((it) => it.toLowerCase()) }
  );
  return result.at(0)?.rates_spent ?? 0;
}
