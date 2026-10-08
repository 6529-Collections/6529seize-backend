import { collectCompetitionPages } from '@/competitions/competition-page';
import { loadCompetitionCreditParity } from '@/competitions/competition-credit-parity';
import { RequestContext } from '@/request.context';
import {
  Competition,
  CompetitionReader,
  CompetitionRoutingRecord,
  CompetitionSnapshot
} from '@/competitions/competition.types';

// A sample must be complete or skipped, never silently truncated into a match.
export const LEGACY_PARITY_ROW_LIMIT = 10_000;

export function parityConfiguration(competition: Competition) {
  return {
    type: competition.type,
    title: competition.title,
    presentation: competition.presentation ?? [],
    lifecycle: competition.lifecycle,
    computed_phase: competition.computed_phase,
    participation: competition.participation,
    voting: competition.voting,
    decisions: competition.decisions,
    winners: competition.winners,
    created_at: competition.created_at,
    updated_at: competition.updated_at,
    ended_at: competition.ended_at
  };
}

/** Projects unified reads onto legacy identities, without loading the baseline. */
export async function loadLegacyParityCandidate(
  reader: CompetitionReader,
  record: CompetitionRoutingRecord,
  now: number,
  ctx: RequestContext
): Promise<CompetitionSnapshot> {
  const collect: typeof collectCompetitionPages = (read, direction) =>
    collectCompetitionPages(read, direction, LEGACY_PARITY_ROW_LIMIT);
  const competition = await reader.getCompetition(record, now);
  const entries = await collect((page) => reader.listEntries(record, page));
  const voters = await collect((page) => reader.listVoters(record, page));
  const leaderboard = await collect(
    (page) => reader.listLeaderboard(record, page),
    'DESC'
  );
  const decisions = await collect((page) => reader.listDecisions(record, page));
  const outcomes = await collect((page) => reader.listOutcomes(record, page));
  const pauses = await collect((page) => reader.listPauses(record, page));
  const outcomesAndDistributions = [];
  for (const outcome of outcomes) {
    const distribution = await collect((page) =>
      reader.listDistribution(record, outcome.id, page)
    );
    outcomesAndDistributions.push({
      position: outcome.position,
      type: outcome.type,
      subtype: outcome.subtype,
      description: outcome.description,
      credit: outcome.credit,
      rep_category: outcome.rep_category,
      amount: outcome.amount,
      distribution: distribution.map((item) => ({
        position: item.position,
        amount: item.amount,
        description: item.description
      }))
    });
  }
  return {
    storage_mode: competition.storage_mode,
    config_version: competition.config_version,
    configuration: parityConfiguration(competition),
    entries: entries
      .map((entry) => ({
        drop_id: entry.drop_id,
        submitter_id: entry.submitter_id,
        status: entry.status,
        submitted_at: entry.submitted_at,
        rank: entry.rank,
        won_at: entry.won_at
      }))
      .sort((a, b) => a.drop_id.localeCompare(b.drop_id)),
    votes_and_credits: [...voters].sort((a, b) =>
      a.profile_id.localeCompare(b.profile_id)
    ),
    credit_budgets: await loadCompetitionCreditParity(
      reader,
      record,
      competition,
      entries,
      voters,
      LEGACY_PARITY_ROW_LIMIT,
      ctx
    ),
    leaderboard: leaderboard.map((entry) => ({
      drop_id: entry.drop_id,
      rating: entry.rating,
      real_time_rating: entry.real_time_rating,
      rank: entry.rank,
      submitted_at: entry.submitted_at
    })),
    decisions_and_winners: decisions.map((decision) => ({
      scheduled_at: decision.scheduled_at,
      decided_at: decision.decided_at,
      status: decision.status,
      winners: decision.winners.map((winner) => ({
        entry_id: winner.entry_id,
        rank: winner.rank,
        final_rating: winner.final_rating
      }))
    })),
    outcomes_and_distributions: outcomesAndDistributions,
    pauses: pauses.map((pause) => ({
      start_time: pause.start_time,
      end_time: pause.end_time
    })),
    capabilities: [...competition.capabilities].sort((a, b) =>
      a.localeCompare(b)
    )
  };
}
