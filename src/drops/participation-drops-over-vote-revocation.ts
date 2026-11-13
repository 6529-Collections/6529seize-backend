import { readSequentially } from '@/competitions/competition-read-sequence';
import { ConnectionWrapper, sqlExecutor } from '@/sql-executor';
import { Time, Timer } from '@/time';
import { RequestContext } from '@/request.context';
import { userNotifier } from '@/notifications/user.notifier';
import { Logger } from '@/logging';
import { appFeatures } from '@/app-features';
import { WaveCreditType } from '@/entities/IWave';
import { nativeCompetitionRuntimeRepository } from '@/competitions/native-competition-runtime.repository';
import { nativeCompetitionRuntimeService } from '@/competitions/native-competition-runtime.service';
import { competitionCreditService } from '@/competitions/competition-credit.service';
import { competitionRepository } from '@/competitions/competition.repository';
import { competitionDropVotesDb } from '@/competitions/competition-drop-votes.db';
import { Competition } from '@/competitions/competition.types';
import { wavesApiDb } from '@/api/waves/waves.api.db';
import { competitionTdhOvervotesDb } from '@/competitions/competition-tdh-overvotes.db';
import { isRetryableDbLockError } from '@/nextgen/nextgen-db-lock-retry';

const logger = Logger.get('PARTICIPATION_DROPS_OVER_VOTE_REVOCATION');

type RepChange = {
  rep_recipient_id: string;
  rep_giver_id: string;
  credit_category: string;
};

export async function revokeRepBasedDropOverVotes(
  change: RepChange,
  connection: ConnectionWrapper<unknown>
): Promise<void> {
  if (!appFeatures.isDropOvervoteRevocationEnabled()) return;
  await revokeNativeOvervotes(
    (competition) =>
      competition.voting.credit_type === WaveCreditType.REP &&
      (competition.voting.credit_category === null ||
        competition.voting.credit_category === change.credit_category) &&
      (competition.voting.credit_creditor === null ||
        competition.voting.credit_creditor === change.rep_giver_id),
    change.rep_recipient_id,
    { connection, timer: new Timer('revokeRepBasedDropOverVotes') }
  );
}

const acceptsTdhCredit = (competition: Competition) =>
  competition.voting.credit_type !== WaveCreditType.REP;

export async function revokeTdhBasedDropWavesOverVotes(
  connection: ConnectionWrapper<unknown>
): Promise<void> {
  await revokeNativeOvervotes(acceptsTdhCredit, null, {
    connection,
    timer: new Timer('revokeTdhBasedWavesOverVotes')
  });
}

/**
 * TDH overvote revocation after an identities sync: the same candidates and
 * reconciliation as `revokeTdhBasedDropWavesOverVotes`, but each candidate
 * competition in its own transaction, so its lock is held only for its own
 * reconciliation rather than until every candidate is done.
 *
 * A candidate that hits a lock wait timeout or deadlock (a busy competition)
 * is rolled back, logged and counted, and the others still run; it is picked
 * up by the next revocation. Any other error fails the step.
 */
export async function revokeTdhBasedDropWavesOverVotesPerCompetition(): Promise<{
  readonly candidates: number;
  readonly failed: number;
  readonly slowestMs: number;
}> {
  let afterId = '';
  let candidates = 0;
  let failed = 0;
  let slowestMs = 0;
  for (;;) {
    const ids =
      await nativeCompetitionRuntimeRepository.findOvervoteCandidateCompetitions(
        afterId,
        100,
        null,
        {}
      );
    if (!ids.length) break;
    for (const id of ids) {
      const start = Time.now();
      try {
        await sqlExecutor.executeNativeQueriesInTransaction((connection) =>
          revokeCandidate(id, acceptsTdhCredit, null, {
            connection,
            timer: new Timer('revokeTdhBasedWavesOverVotes')
          })
        );
      } catch (error) {
        if (!isRetryableDbLockError(error)) throw error;
        failed++;
        logger.warn(
          `[TDH OVERVOTE REVOCATION SKIPPED] [COMPETITION ${id}] [LEFT FOR THE NEXT REVOCATION] ${error}`
        );
      }
      candidates++;
      slowestMs = Math.max(slowestMs, start.diffFromNow().toMillis());
    }
    afterId = ids[ids.length - 1];
  }
  logger.info(
    `[TDH OVERVOTE REVOCATION] candidates=${candidates} failed=${failed} slowest_competition_ms=${slowestMs}`
  );
  return { candidates, failed, slowestMs };
}

function isRevocable(
  competition: Competition | null,
  accepts: (competition: Competition) => boolean
): competition is Competition {
  return (
    !!competition &&
    accepts(competition) &&
    competition.execution_mode === 'ACTIVE' &&
    competition.lifecycle === 'PUBLISHED'
  );
}

/**
 * Locks only candidate competitions: those with votes this revocation could
 * reduce, whose configuration (read without locking) it applies to. Each is
 * re-checked under its lock, since its configuration may have changed. A
 * competition that becomes a candidate after the unlocked read holds only
 * votes cast since, under its own lock and against the credit current then
 * (after a TDH sync, the synced credit); the next revocation or the
 * vote-time credit check covers those.
 */
async function revokeNativeOvervotes(
  accepts: (competition: Competition) => boolean,
  profileId: string | null,
  ctx: RequestContext
): Promise<void> {
  let afterId = '';
  for (;;) {
    const ids =
      await nativeCompetitionRuntimeRepository.findOvervoteCandidateCompetitions(
        afterId,
        100,
        profileId,
        ctx
      );
    if (!ids.length) return;
    await readSequentially(ids, (id) =>
      revokeCandidate(id, accepts, profileId, ctx)
    );
    afterId = ids[ids.length - 1];
  }
}

/** Reads the candidate unlocked, locks it only if it applies, re-checks. */
async function revokeCandidate(
  id: string,
  accepts: (competition: Competition) => boolean,
  profileId: string | null,
  ctx: RequestContext
): Promise<void> {
  const unlocked = await nativeCompetitionRuntimeRepository.readCompetition(
    id,
    ctx
  );
  if (!isRevocable(unlocked, accepts)) return;
  const competition = await nativeCompetitionRuntimeRepository.lockCompetition(
    id,
    ctx
  );
  if (!isRevocable(competition, accepts)) return;
  if (profileId) await reconcileNativeVoter(competition, profileId, ctx);
  else await reconcileTdhOvervoters(competition, ctx);
}

async function reconcileNativeVoter(
  competition: Competition,
  profileId: string,
  ctx: RequestContext
): Promise<void> {
  if ((await reduceNativeVoter(competition, profileId, ctx)) === null) return;
  await nativeCompetitionRuntimeService.refreshCompetition(
    competition.id,
    Date.now(),
    ctx
  );
  logger.info(
    `Reconciled competition ${competition.id} credit for ${profileId}`
  );
}

async function reconcileTdhOvervoters(
  competition: Competition,
  ctx: RequestContext
): Promise<void> {
  const voters = await competitionTdhOvervotesDb.findOvervoters(
    competition,
    ctx
  );
  let changed = 0;
  await readSequentially(voters, async (voter) => {
    if (await reduceNativeVoter(competition, voter, ctx)) changed++;
  });
  if (!changed) return;
  const now = Date.now();
  // Match normal refresh: publish due transitions before the leaderboard update.
  await nativeCompetitionRuntimeService.enqueueDueTransitions(
    competition,
    now,
    ctx
  );
  await nativeCompetitionRuntimeService.refreshLeaderboardAfterCreditReconciliation(
    competition,
    now,
    ctx
  );
  logger.info(
    `Reconciled competition ${competition.id} TDH overvotes for ${changed} voters`
  );
}

/** null means there are no active votes; false means none required reducing. */
async function reduceNativeVoter(
  competition: Competition,
  profileId: string,
  ctx: RequestContext
): Promise<boolean | null> {
  const before = await nativeCompetitionRuntimeRepository.getVoterActiveVotes(
    competition.id,
    profileId,
    ctx
  );
  if (!before.length) return null;
  const budget = await competitionCreditService.getBudget(
    competition,
    profileId,
    undefined,
    ctx
  );
  await nativeCompetitionRuntimeService.reconcileVoterCredit(
    {
      competitionId: competition.id,
      voterProfileId: profileId,
      availableCredit: budget.available,
      creditScope: competition.voting.credit_scope,
      occurredAt: Date.now()
    },
    ctx
  );
  const after = new Map(
    (
      await nativeCompetitionRuntimeRepository.getVoterActiveVotes(
        competition.id,
        profileId,
        ctx
      )
    ).map((vote) => [vote.entryId, vote.value])
  );
  let changed = false;
  for (const vote of before) {
    const value = after.get(vote.entryId) ?? 0;
    if (value === vote.value) continue;
    changed = true;
    const entry = await competitionRepository.findNativeEntry(
      competition.id,
      vote.entryId,
      ctx
    );
    if (!entry || entry.submitter_id === profileId) continue;
    const wave = await wavesApiDb.findById(competition.wave_id, ctx.connection);
    if (!wave) continue;
    const total = await competitionDropVotesDb.totals(entry, null, ctx);
    await userNotifier.notifyOfDropVote(
      {
        voter_id: profileId,
        drop_id: entry.drop_id,
        wave_id: competition.wave_id,
        drop_author_id: entry.submitter_id,
        vote: value,
        vote_change: value - vote.value,
        total_vote: total.total
      },
      wave.visibility_group_id,
      ctx.connection
    );
  }
  return changed;
}
