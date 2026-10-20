import { ApiCompetitionDraftInput } from '@/api/generated/models/ApiCompetitionDraftInput';
import { competitionPayloadHash } from '@/competitions/competition-command-identity';
import {
  competitionCommandRepository,
  competitionConflict
} from '@/competitions/competition-command.repository';
import { Competition } from '@/competitions/competition.types';
import { COMPETITION_DECISIONS_TABLE } from '@/constants';
import { BadRequestException, ForbiddenException } from '@/exceptions';
import { RequestContext } from '@/request.context';
import { dbSupplier } from '@/sql-executor';

type OriginalPrimaryRuleState = Pick<Competition, 'id' | 'type' | 'decisions'>;

function assertFixedDefinitions(
  previous: ApiCompetitionDraftInput,
  next: ApiCompetitionDraftInput
) {
  if (next.rules.type !== previous.rules.type)
    throw new BadRequestException('Original competition type cannot change');
  if (
    competitionPayloadHash(next.participation.submission_strategy ?? null) !==
    competitionPayloadHash(previous.participation.submission_strategy ?? null)
  )
    throw new BadRequestException(
      'Wave identity submission strategy cannot be changed after creation'
    );
  if (
    competitionPayloadHash(next.outcomes) !==
    competitionPayloadHash(previous.outcomes)
  )
    throw new BadRequestException(
      'Original competition outcome definitions are immutable'
    );
}

function assertVoteLimitCanIncrease(
  previous: ApiCompetitionDraftInput,
  next: ApiCompetitionDraftInput
) {
  const current = previous.rules.max_votes_per_identity_to_drop ?? null;
  const requested = next.rules.max_votes_per_identity_to_drop;
  if (
    requested !== undefined &&
    requested !== null &&
    (current === null || requested < current)
  )
    throw new BadRequestException(
      'max_votes_per_identity_to_drop can only be increased after creation'
    );
}

function votingCreditRules({ voting }: ApiCompetitionDraftInput) {
  const {
    credit_type,
    credit_scope,
    credit_category,
    creditor_id,
    credit_nfts,
    forbid_negative_votes
  } = voting;
  return {
    credit_type,
    credit_scope,
    credit_category,
    creditor_id,
    credit_nfts,
    forbid_negative_votes
  };
}

async function assertWinnerLimit(
  next: ApiCompetitionDraftInput,
  competitionId: string,
  ctx: RequestContext
) {
  if (next.rules.type !== 'APPROVE' || next.rules.max_winners === null) return;
  const row = await dbSupplier().oneOrNull<{ count: number | string }>(
    `select count(*) as count from ${COMPETITION_DECISIONS_TABLE} where competition_id=:competitionId and status='COMPLETED'`,
    { competitionId },
    { wrappedConnection: ctx.connection }
  );
  if (next.rules.max_winners < Number(row?.count ?? 0))
    throw new BadRequestException(
      "max_winners can't be lower than already declared winners count"
    );
}

/** The caller restricts this policy to the immutable original primary and holds
 * its native competition lock. Shared wave fields and sibling policy stay with
 * their own command handlers. */
export async function validateOriginalPrimaryRuleUpdate(
  previousConfig: ApiCompetitionDraftInput,
  nextConfig: ApiCompetitionDraftInput,
  competition: OriginalPrimaryRuleState,
  ctx: RequestContext
): Promise<{ scheduleChanged: boolean; nextDecisionTime: number | null }> {
  if (ctx.authenticationContext?.isAuthenticatedAsProxy())
    throw new ForbiddenException(
      'Legacy competition settings cannot be changed by proxies'
    );
  const now = Date.now();
  if (
    competition.decisions.next_decision_time !== null &&
    competition.decisions.next_decision_time < now
  )
    throw new ForbiddenException(
      "Wave has unresolved decisions and can't be edited at the moment. Try again later"
    );
  assertFixedDefinitions(previousConfig, nextConfig);
  assertVoteLimitCanIncrease(previousConfig, nextConfig);
  const nextStrategy = nextConfig.rules.decisions_strategy ?? null;
  const scheduleChanged =
    competitionPayloadHash(previousConfig.rules.decisions_strategy ?? null) !==
    competitionPayloadHash(nextStrategy);
  if (
    scheduleChanged &&
    nextStrategy !== null &&
    nextStrategy.first_decision_time < now
  )
    throw new BadRequestException('first_decision_time must be in the future');
  if (
    competitionPayloadHash(votingCreditRules(previousConfig)) !==
      competitionPayloadHash(votingCreditRules(nextConfig)) &&
    (await competitionCommandRepository.hasVotes(competition.id, ctx))
  )
    competitionConflict(
      'Voting credit rules are immutable after the first vote'
    );
  await assertWinnerLimit(nextConfig, competition.id, ctx);
  return {
    scheduleChanged,
    nextDecisionTime: scheduleChanged
      ? (nextStrategy?.first_decision_time ?? null)
      : competition.decisions.next_decision_time
  };
}
