import { VOTE_EVENTS_TABLE, VOTE_MATTERS_CATEGORIES_TABLE } from './constants';
import { sqlExecutor } from './sql-executor';

import { randomUUID } from 'crypto';
import {
  VoteCategoryMedia,
  VoteMatterCategory,
  VoteMatterTargetType
} from './entities/IVoteMatter';
import { VoteEvent, VoteEventReason } from './entities/IVoteEvent';
import { Time } from './time';
import { BadRequestException } from './exceptions';
import * as tdh_consolidation from './tdh_consolidation';
import { Logger } from './logging';

const logger = Logger.get('VOTES');

async function getCategoriesForMatter({
  matter,
  matterTargetType
}: {
  matter: string;
  matterTargetType: VoteMatterTargetType;
}): Promise<VoteMatterCategory[]> {
  return sqlExecutor.execute(
    `SELECT * FROM ${VOTE_MATTERS_CATEGORIES_TABLE} 
    WHERE matter_target_type = :matterTargetType 
    AND matter = :matter`,
    { matterTargetType, matter }
  );
}

async function insertVoteEvent(voteEvent: VoteEvent) {
  await sqlExecutor.execute(
    `INSERT INTO ${VOTE_EVENTS_TABLE} (id,
                                       voter_wallet,
                                       matter_target_id,
                                       matter_target_type,
                                       matter,
                                       matter_category,
                                       event_reason,
                                       amount,
                                       created_time)
     values (:id,
             :voterWallet,
             :matterTargetId,
             :matterTargetType,
             :matter,
             :matterCategory,
             :eventReason,
             :amount,
             current_time)`,
    {
      id: voteEvent.id,
      voterWallet: voteEvent.voter_wallet,
      matterTargetId: voteEvent.matter_target_id,
      matterTargetType: voteEvent.matter_target_type,
      matter: voteEvent.matter,
      matterCategory: voteEvent.matter_category,
      eventReason: voteEvent.event_reason,
      amount: voteEvent.amount
    }
  );
}

export async function registerUserVote({
  voterWallet,
  matter,
  matterTargetType,
  matterTargetId,
  category,
  amount
}: {
  voterWallet: string;
  matter: string;
  matterTargetType: VoteMatterTargetType;
  matterTargetId: string;
  category: string;
  amount: number;
}) {
  const { votesLeft, consolidatedWallets } =
    await getVotesLeftOnMatterForWallet({
      wallet: voterWallet,
      matter,
      matterTargetType
    });
  const votesTallyForWalletOnMatterByCategories =
    await getVotesTallyForWalletOnMatterByCategories({
      matter,
      matterTargetType,
      matterTargetId,
      wallets: consolidatedWallets
    });
  const votesSpentOnGivenCategory =
    votesTallyForWalletOnMatterByCategories[category] ?? 0;
  if (amount === 0) {
    return;
  }
  if (amount < 0 && Math.abs(amount) > votesSpentOnGivenCategory) {
    throw new BadRequestException(
      `Wallet tried to revoke ${amount} votes on matter and category but has only historically given ${votesSpentOnGivenCategory} votes`
    );
  }
  if (amount > 0 && votesLeft < amount) {
    throw new BadRequestException(
      `Wallet tried to give ${amount} votes on matter without enough votes left. Votes left: ${votesLeft}`
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
      `Tried to vote on matter with category ${category} but no active category with such tag exists for this matter`
    );
  }
  await insertVoteEvent({
    id: randomUUID(),
    voter_wallet: voterWallet,
    matter_target_id: matterTargetId,
    matter_target_type: matterTargetType,
    matter,
    matter_category: category,
    event_reason: VoteEventReason.USER_VOTED,
    amount,
    created_time: new Date()
  });
}

export async function getVotesLeftOnMatterForWallet({
  wallet,
  matter,
  matterTargetType
}: {
  wallet: string;
  matter: string;
  matterTargetType: VoteMatterTargetType;
}): Promise<{
  votesLeft: number;
  votesSpent: number;
  consolidatedWallets: string[];
}> {
  const { tdh, consolidatedWallets } =
    await tdh_consolidation.getWalletTdhAndConsolidatedWallets(wallet);
  if (
    !consolidatedWallets.find((w) => w.toLowerCase() === wallet.toLowerCase())
  ) {
    consolidatedWallets.push(wallet.toLowerCase());
  }
  const votesSpent = await getTotalVotesSpentOnMatterByWallets({
    wallets: consolidatedWallets,
    matter,
    matterTargetType
  });
  return {
    votesLeft: tdh - votesSpent,
    votesSpent,
    consolidatedWallets
  };
}

async function getVotesTallyForWalletOnMatterByCategories({
  wallets,
  matter,
  matterTargetType,
  matterTargetId
}: {
  wallets: string[];
  matter: string;
  matterTargetType: VoteMatterTargetType;
  matterTargetId: string;
}): Promise<Record<string, number>> {
  if (!wallets.length) {
    return {};
  }
  const result: { matter_category: string; vote_tally: number }[] =
    await sqlExecutor.execute(
      `SELECT matter_category, SUM(amount) AS vote_tally FROM ${VOTE_EVENTS_TABLE}
      WHERE LOWER(voter_wallet) IN (:wallets)
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
    acc[row.matter_category] = row.vote_tally;
    return acc;
  }, {} as Record<string, number>);
}

export interface VoteCategoryInfo {
  category_tag: string;
  tally: number;
  category_display_name: string;
  category_media: VoteCategoryMedia;
  category_enabled: boolean;
  authenticated_wallet_votes: number;
}

async function getTotalTalliesByCategories(
  matterTargetType: VoteMatterTargetType,
  matterTargetId: string,
  matter: string
): Promise<Record<string, number>> {
  const totalTallies: {
    matter_category: string;
    vote_tally: number;
  }[] = await sqlExecutor.execute(
    `SELECT matter_category, SUM(amount) AS vote_tally FROM ${VOTE_EVENTS_TABLE}
    WHERE matter_target_type = :matterTargetType
    AND matter_target_id = :matterTargetId
    AND matter = :matter
    GROUP BY matter, matter_category`,
    { matterTargetType, matterTargetId, matter }
  );
  return totalTallies.reduce((acc, row) => {
    acc[row.matter_category] = row.vote_tally;
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
  matterTargetType: VoteMatterTargetType;
  matter: string;
  matterTargetId: string;
}): Promise<VoteCategoryInfo[]> {
  const categories = await getCategoriesForMatter({
    matter,
    matterTargetType
  });
  const totalTalliesByCategory = await getTotalTalliesByCategories(
    matterTargetType,
    matterTargetId,
    matter
  );
  const walletsVotesByCategory =
    await getVotesTallyForWalletOnMatterByCategories({
      wallets,
      matter,
      matterTargetType,
      matterTargetId
    });
  return categories.map<VoteCategoryInfo>((c) => ({
    tally: totalTalliesByCategory[c.matter_category_tag] ?? 0,
    authenticated_wallet_votes:
      walletsVotesByCategory[c.matter_category_tag] ?? 0,
    category_tag: c.matter_category_tag,
    category_enabled: !c.disabled_time,
    category_display_name: c.matter_category_displayName,
    category_media: JSON.parse(c.matter_category_media || '{}')
  }));
}

function calculateOvervoteSummaries(
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
  // create mock 0 tdhs for wallets that have historically voted but are not part of community anymore
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
          voteParticipatingWallets: string[];
          tdh: number;
        }
      > = {};
      // aggregate all consolidation group votes by matter
      for (const wallet of activeTdh.wallets) {
        const allMattersTalliesForWallet = talliesByWallets[wallet] || {};
        for (const [key, matterTallyDescription] of Object.entries(
          allMattersTalliesForWallet
        )) {
          if (!talliesForConsolidationGroupsByMatter[key]) {
            // for the first wallet in consolidation group that has spent votes on this matter
            talliesForConsolidationGroupsByMatter[key] = {
              matter: matterTallyDescription.matter,
              matter_target_type: matterTallyDescription.matter_target_type,
              tally: matterTallyDescription.tally,
              voteParticipatingWallets: [wallet],
              tdh: activeTdh.tdh
            };
          } else {
            // for other wallets in consolidation group that has spent votes on this matter
            talliesForConsolidationGroupsByMatter[key] = {
              matter: matterTallyDescription.matter,
              matter_target_type: matterTallyDescription.matter_target_type,
              tally:
                talliesForConsolidationGroupsByMatter[key].tally +
                matterTallyDescription.tally,
              voteParticipatingWallets: [
                wallet,
                ...talliesForConsolidationGroupsByMatter[key]
                  .voteParticipatingWallets
              ],
              tdh: activeTdh.tdh
            };
          }
        }
      }
      // keep only the ones where vote count exceeds TDH
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
      voteParticipatingWallets: string[];
    }[]
  );
}

async function getAllVoteMatterTalliesByWallets() {
  const activeVoteTally: {
    voter_wallet: string;
    matter: string;
    matter_target_type: VoteMatterTargetType;
    vote_tally: number;
  }[] = await sqlExecutor.execute(
    `select voter_wallet, matter, matter_target_type, sum(amount) as vote_tally from ${VOTE_EVENTS_TABLE} group by voter_wallet, matter, matter_target_type`
  );
  return activeVoteTally.reduce((a, vt) => {
    const voter_wallet = vt.voter_wallet.toLowerCase();
    if (!a[voter_wallet]) {
      a[voter_wallet] = {};
    }
    a[voter_wallet][`${vt.matter}-${vt.matter_target_type}`] = {
      matter: vt.matter,
      matter_target_type: vt.matter_target_type,
      tally: +vt.vote_tally
    };
    return a;
  }, {} as Record<string, Record<string, { matter: string; matter_target_type: string; tally: number }>>);
}

async function createRevocationEvents(
  allOverVotes: {
    tdh: number;
    tally: number;
    matter: string;
    matter_target_type: string;
    voteParticipatingWallets: string[];
  }[]
) {
  for (const overVote of allOverVotes) {
    const overvoteAmount = overVote.tally - overVote.tdh;

    const toBeRevokedEvents: VoteEvent[] = await sqlExecutor.execute(
      `WITH full_overvotes AS (SELECT NULL AS id, NULL AS total
                               FROM dual
                               WHERE (@total := 0)
                               UNION
                               SELECT ve.id, @total := @total + ve.amount AS total
                               FROM (SELECT id, amount
                                     FROM vote_events
                                     WHERE LOWER(voter_wallet) IN (:voteParticipantsIn)
                                       AND matter = :matter
                                     ORDER BY created_time desc) ve
                               WHERE @total < :overvoteAmount)
       SELECT *
       FROM vote_events
       WHERE id IN (SELECT id FROM full_overvotes)
       ORDER BY created_time DESC`,
      {
        matter: overVote.matter,
        overvoteAmount,
        voteParticipantsIn: overVote.voteParticipatingWallets.map((it) =>
          it.toLowerCase()
        )
      }
    );
    const reverseVoteEventsByKey: Record<string, VoteEvent> = {};
    let reverseVoteAmount = 0;
    for (const event of toBeRevokedEvents) {
      const key = `${event.matter}-${event.matter_target_type}-${event.voter_wallet}-${event.matter_target_id}-${event.matter_category}`;
      let toAdd = event.amount;
      if (reverseVoteAmount + toAdd > overvoteAmount) {
        toAdd = overvoteAmount - reverseVoteAmount;
      }
      reverseVoteAmount += toAdd;
      if (!reverseVoteEventsByKey[key]) {
        reverseVoteEventsByKey[key] = {
          ...event,
          id: randomUUID(),
          created_time: new Date(),
          event_reason: VoteEventReason.TDH_CHANGED,
          amount: -toAdd
        };
      } else {
        reverseVoteEventsByKey[key].amount -= toAdd;
      }
    }
    const reverseVoteEvents = Object.values(reverseVoteEventsByKey).filter(
      (e) => e.amount !== 0
    );
    for (const reverseVoterEvent of reverseVoteEvents) {
      await insertVoteEvent(reverseVoterEvent);
    }
    logger.info(
      `Created ${reverseVoteEvents.length} vote revocation events on matter ${overVote.matter_target_type}/${overVote.matter}`
    );
  }
}

export async function revokeOverVotes() {
  const startTime = Time.now();
  logger.info(`Fetching current TDH's...`);
  const activeTdhs = await tdh_consolidation.getAllTdhs();
  logger.info(`Fetching current vote tallies...`);
  const talliesByWallets = await getAllVoteMatterTalliesByWallets();
  logger.info(`Figuring out overvotes...`);
  const allOverVotes = calculateOvervoteSummaries(activeTdhs, talliesByWallets);
  logger.info(`Revoking overvotes...`);
  await createRevocationEvents(allOverVotes);
  logger.info(`All overvotes revoked in ${startTime.diffFromNow()}`);
}

async function getTotalVotesSpentOnMatterByWallets({
  wallets,
  matter,
  matterTargetType
}: {
  wallets: string[];
  matter: string;
  matterTargetType: VoteMatterTargetType;
}): Promise<number> {
  if (!wallets.length) {
    return 0;
  }
  const result: { votes_spent: number }[] = await sqlExecutor.execute(
    `SELECT SUM(amount) AS votes_spent FROM ${VOTE_EVENTS_TABLE}
     WHERE LOWER(voter_wallet) IN (:wallets) 
     AND matter = :matter 
     AND matter_target_type = :matterTargetType`,
    { matter, matterTargetType, wallets: wallets.map((it) => it.toLowerCase()) }
  );
  return result.at(0)?.votes_spent ?? 0;
}
