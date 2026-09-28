import {
  CompetitionCreditRepository,
  CompetitionCreditSpending,
  competitionCreditRepository
} from '@/competitions/competition-credit.repository';
import {
  Competition,
  CompetitionEntry
} from '@/competitions/competition.types';
import { CompetitionEntryStatus } from '@/entities/ICompetition';
import { WaveCreditScope, WaveCreditType } from '@/entities/IWave';
import { BadRequestException } from '@/exceptions';
import { IdentitiesDb, identitiesDb } from '@/identities/identities.db';
import { RatingsDb, ratingsDb } from '@/rates/ratings.db';
import { RequestContext } from '@/request.context';
import {
  normalizeWaveVotingCreditNfts,
  sumWaveVotingCreditNftValues,
  WaveVotingCreditNft
} from '@/waves/wave-voting-credit-nfts';

export type CompetitionCreditBudget = {
  readonly competition_id: string;
  readonly profile_id: string;
  readonly entry_id: string | null;
  readonly credit_type: string;
  readonly credit_scope: string;
  /** Total currently derived, whole, nonnegative voting credit. */
  readonly available: number;
  /** DROP scope has no competition-wide spent or remaining amount. */
  readonly spent: number | null;
  readonly remaining: number | null;
  readonly current_vote: number | null;
  readonly min_vote: number | null;
  readonly max_vote: number | null;
};

type BudgetCompetition = Pick<
  Competition,
  'id' | 'wave_id' | 'storage_mode' | 'voting'
>;
type BudgetEntry = Pick<CompetitionEntry, 'id' | 'drop_id'> &
  Partial<Pick<CompetitionEntry, 'status'>>;

/** A sign change can exceed the safe-number range even when both votes fit. */
export function competitionVoteDelta(
  previousValue: number,
  value: number
): string {
  if (!Number.isSafeInteger(previousValue) || !Number.isSafeInteger(value))
    throw new BadRequestException('Vote must be a safe integer');
  return (BigInt(value) - BigInt(previousValue)).toString();
}

function assertValidSpending(
  spent: number | null,
  spending: CompetitionCreditSpending
): void {
  const amounts = [spending.entry_spent, ...(spent === null ? [] : [spent])];
  if (
    amounts.some((amount) => !Number.isSafeInteger(amount) || amount < 0) ||
    !Number.isSafeInteger(spending.current_vote) ||
    (spent !== null && spent < spending.entry_spent)
  )
    throw new Error(
      'Competition spending is outside the supported integer range'
    );
}

function voteRange(
  voting: Competition['voting'],
  entry: BudgetEntry | undefined,
  available: number,
  spent: number | null,
  spending: CompetitionCreditSpending
): Pick<CompetitionCreditBudget, 'current_vote' | 'min_vote' | 'max_vote'> {
  if (!entry || spent === null) {
    return { current_vote: null, min_vote: null, max_vote: null };
  }
  const current = spending.current_vote;
  if (
    entry.status !== undefined &&
    entry.status !== CompetitionEntryStatus.ACTIVE
  ) {
    return { current_vote: current, min_vote: current, max_vote: current };
  }
  const capacity = Math.min(
    Math.max(0, available - spent + spending.entry_spent),
    voting.max_votes_per_identity_to_entry ?? Number.MAX_SAFE_INTEGER
  );
  return {
    current_vote: current,
    min_vote: voting.forbid_negative_votes || capacity === 0 ? 0 : -capacity,
    max_vote: capacity
  };
}

function creditNfts(voting: Competition['voting']): WaveVotingCreditNft[] {
  const nfts = voting.credit_nfts.map((nft) => ({
    contract: String(nft.contract ?? ''),
    tokenId: Number(nft.token_id ?? nft.tokenId)
  }));
  if (
    !nfts.length ||
    nfts.some(
      (nft) =>
        !/^0x[0-9a-f]{40}$/i.test(nft.contract) ||
        !Number.isSafeInteger(nft.tokenId) ||
        nft.tokenId < 0
    )
  ) {
    throw new Error('CARD_SET_TDH requires valid voting credit NFTs');
  }
  return normalizeWaveVotingCreditNfts(nfts);
}

/**
 * Authoritative budget reads for an already authorized effective profile.
 * Mutating callers must hold the native competition lock and read/write within
 * the same transaction. Visibility, proxy rights, groups and lifecycle are
 * enforced by the caller; an available budget alone does not grant voting rights.
 */
export class CompetitionCreditService {
  public constructor(
    private readonly repository: Pick<
      CompetitionCreditRepository,
      'getSpending'
    >,
    private readonly identities: Pick<
      IdentitiesDb,
      'getIdentityByProfileId' | 'getSingleNftVotingCreditsByProfileId'
    >,
    private readonly ratings: Pick<RatingsDb, 'getRepRating'>
  ) {}

  public async getBudget(
    competition: BudgetCompetition,
    profileId: string,
    entry: BudgetEntry | undefined,
    ctx: RequestContext
  ): Promise<CompetitionCreditBudget> {
    const scope = competition.voting.credit_scope;
    if (scope !== WaveCreditScope.WAVE && scope !== WaveCreditScope.DROP) {
      throw new Error(`Unsupported competition credit scope: ${scope}`);
    }
    // Sequential queries also work with callers' single transaction connection.
    const available = await this.getAvailable(
      competition.voting,
      profileId,
      ctx
    );
    const spending = await this.repository.getSpending(
      competition,
      profileId,
      entry,
      ctx
    );
    const spent =
      scope === WaveCreditScope.WAVE
        ? spending.namespace_spent
        : entry
          ? spending.entry_spent
          : null;
    assertValidSpending(spent, spending);
    const remaining = spent === null ? null : Math.max(0, available - spent);
    return {
      competition_id: competition.id,
      profile_id: profileId,
      entry_id: entry?.id ?? null,
      credit_type: competition.voting.credit_type,
      credit_scope: scope,
      available,
      spent,
      remaining,
      ...voteRange(competition.voting, entry, available, spent, spending)
    };
  }

  /** Applies replacement-vote accounting; the caller writes only after success. */
  public assertVoteFits(budget: CompetitionCreditBudget, value: number): void {
    if (!Number.isSafeInteger(value))
      throw new BadRequestException('Vote must be a safe integer');
    if (
      budget.min_vote === null ||
      budget.max_vote === null ||
      budget.spent === null ||
      budget.current_vote === null
    ) {
      throw new BadRequestException('An entry is required to validate a vote');
    }
    if (
      value < budget.min_vote ||
      value > budget.max_vote ||
      budget.spent - Math.abs(budget.current_vote) + Math.abs(value) >
        budget.available
    ) {
      throw new BadRequestException(
        'Vote exceeds available credit or entry voting limits'
      );
    }
  }

  private async getAvailable(
    voting: Competition['voting'],
    profileId: string,
    ctx: RequestContext
  ): Promise<number> {
    let amount: number;
    if (voting.credit_type === WaveCreditType.REP) {
      amount = await this.ratings.getRepRating(
        {
          target_profile_id: profileId,
          rater_profile_id: voting.credit_creditor,
          category: voting.credit_category
        },
        ctx
      );
    } else if (voting.credit_type === WaveCreditType.CARD_SET_TDH) {
      const nfts = creditNfts(voting);
      const values = await this.identities.getSingleNftVotingCreditsByProfileId(
        profileId,
        nfts,
        ctx
      );
      amount = sumWaveVotingCreditNftValues(nfts, values);
    } else {
      const supported = [
        WaveCreditType.TDH,
        WaveCreditType.XTDH,
        WaveCreditType.TDH_PLUS_XTDH
      ];
      if (!supported.includes(voting.credit_type as WaveCreditType)) {
        throw new Error(
          `Unsupported competition credit type: ${voting.credit_type}`
        );
      }
      const identity = await this.identities.getIdentityByProfileId(
        profileId,
        ctx.connection
      );
      const tdh = Number(identity?.tdh ?? 0);
      const xtdh = Number(identity?.xtdh ?? 0);
      amount =
        voting.credit_type === WaveCreditType.TDH
          ? tdh
          : voting.credit_type === WaveCreditType.XTDH
            ? xtdh
            : tdh + xtdh;
    }
    const available = Math.max(0, Math.floor(Number(amount)));
    if (!Number.isSafeInteger(available))
      throw new Error(
        'Competition voting credit is outside the supported integer range'
      );
    return available;
  }
}

export const competitionCreditService = new CompetitionCreditService(
  competitionCreditRepository,
  identitiesDb,
  ratingsDb
);
