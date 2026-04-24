import { RequestContext } from '../../../request.context';
import { identitiesDb, IdentitiesDb } from '../../../identities/identities.db';
import { wavesApiDb, WavesApiDb } from '../waves/waves.api.db';
import {
  userGroupsService,
  UserGroupsService
} from '../community-members/user-groups.service';
import { DropEntity, DropType } from '../../../entities/IDrop';
import { DropVotingDb, dropVotingDb } from './drop-voting.db';
import { WaveCreditType, WaveEntity } from '../../../entities/IWave';
import { ConnectionWrapper } from '../../../sql-executor';
import { ratingsDb, RatingsDb } from '../../../rates/ratings.db';
import { Rating } from '../../../entities/IRating';
import { collections } from '../../../collections';
import { assertUnreachable } from '../../../assertions';
import {
  normalizeWaveVotingCreditNfts,
  sumWaveVotingCreditNftValues,
  WaveVotingCreditNft
} from '@/waves/wave-voting-credit-nfts';

type WaveWithVotingCreditNfts = WaveEntity & {
  voting_credit_nfts: WaveVotingCreditNft[];
};

export class DropVotingService {
  constructor(
    private readonly votingDb: DropVotingDb,
    private readonly identitiesDb: IdentitiesDb,
    private readonly wavesDb: WavesApiDb,
    private readonly ratingsDb: RatingsDb,
    private readonly userGroupsService: UserGroupsService
  ) {}

  private getWaveTotalCredit({
    wave,
    repRatings,
    tdh,
    xtdh,
    cardSetCredits
  }: {
    wave: Pick<
      WaveWithVotingCreditNfts,
      | 'id'
      | 'voting_credit_type'
      | 'voting_credit_category'
      | 'voting_credit_creditor'
      | 'voting_credit_nfts'
    >;
    repRatings: Rating[];
    tdh: number;
    xtdh: number;
    cardSetCredits: Record<string, number>;
  }): number {
    switch (wave.voting_credit_type) {
      case WaveCreditType.REP:
        return repRatings
          .filter(
            (it) =>
              (wave.voting_credit_creditor === null ||
                wave.voting_credit_creditor === it.rater_profile_id) &&
              (wave.voting_credit_category === null ||
                wave.voting_credit_category === it.matter_category)
          )
          .reduce((acc, it) => acc + it.rating, 0);
      case WaveCreditType.TDH:
        return tdh;
      case WaveCreditType.XTDH:
        return Math.floor(xtdh);
      case WaveCreditType.TDH_PLUS_XTDH:
        return Math.floor(tdh + xtdh);
      case WaveCreditType.CARD_SET_TDH:
        if (!wave.voting_credit_nfts.length) {
          throw new Error(
            `Wave ${wave.id} is misconfigured: CARD_SET_TDH requires voting credit nfts`
          );
        }
        return sumWaveVotingCreditNftValues(
          wave.voting_credit_nfts,
          cardSetCredits
        );
      default:
        throw assertUnreachable(wave.voting_credit_type);
    }
  }

  private getAllowedVoteRange({
    activeVote,
    totalCredit,
    totalVotesInWave,
    perDropLimit
  }: {
    activeVote: number;
    totalCredit: number;
    totalVotesInWave: number;
    perDropLimit: number | null;
  }): { min: number; current: number; max: number } {
    const creditLeft = Math.max(0, totalCredit - totalVotesInWave);
    let min: number;
    let max: number;

    if (activeVote < 0) {
      min = -(creditLeft - activeVote);
      max = -activeVote + creditLeft;
    } else if (activeVote > 0) {
      min = -activeVote - creditLeft;
      max = activeVote + creditLeft;
    } else {
      min = -creditLeft;
      max = creditLeft;
    }

    if (perDropLimit !== null) {
      min = Math.max(min, -perDropLimit);
      max = Math.min(max, perDropLimit);
    }

    return {
      min,
      current: activeVote,
      max
    };
  }

  async findCreditLeftForVotingForDrops(
    profileId: string | null | undefined,
    dropEntities: DropEntity[],
    connection?: ConnectionWrapper<any>
  ): Promise<Record<string, { min: number; max: number; current: number }>> {
    if (!profileId) {
      return {};
    }
    const groupIdsUserIsEligibleFor =
      await this.userGroupsService.getGroupsUserIsEligibleFor(profileId);
    const participationDrops = dropEntities.filter(
      (drop) => drop.drop_type === DropType.PARTICIPATORY
    );
    const relevantWaveIds = collections.distinct(
      participationDrops.map((drop) => drop.wave_id)
    );
    const relevantWaves = await this.wavesDb.findWavesByIds(
      relevantWaveIds,
      groupIdsUserIsEligibleFor,
      connection
    );
    const waveIds = relevantWaves.map((it) => it.id);
    const waveVotingCreditNftsByWaveId =
      await this.wavesDb.findWaveVotingCreditNftsByWaveIds(waveIds, connection);
    const relevantWavesWithCredits: WaveWithVotingCreditNfts[] =
      relevantWaves.map((wave) => ({
        ...wave,
        voting_credit_nfts: waveVotingCreditNftsByWaveId[wave.id] ?? []
      }));
    const relevantParticipationDrops = participationDrops.filter((drop) =>
      waveIds.includes(drop.wave_id)
    );
    const relevantParticipationDropIds = relevantParticipationDrops.map(
      (it) => it.id
    );
    const repWaves = relevantWavesWithCredits.filter(
      (it) => it.voting_credit_type === WaveCreditType.REP
    );
    const repWaveConditions = repWaves
      .map((it) => ({
        category: it.voting_credit_category,
        rater_id: it.voting_credit_creditor
      }))
      .filter((it) => it.rater_id !== null || it.category !== null);
    const needsGlobalIdentityCredit = relevantWavesWithCredits.some((it) =>
      [
        WaveCreditType.TDH,
        WaveCreditType.XTDH,
        WaveCreditType.TDH_PLUS_XTDH
      ].includes(it.voting_credit_type)
    );
    const cardSetCreditNfts = normalizeWaveVotingCreditNfts(
      relevantWavesWithCredits.flatMap((wave) =>
        wave.voting_credit_type === WaveCreditType.CARD_SET_TDH
          ? wave.voting_credit_nfts
          : []
      )
    );
    const hasOnlyOneRestriction =
      collections.distinct(
        repWaveConditions.map((it) => `${it.category}-${it.rater_id}`)
      ).length === 1;
    const [
      activeVotes,
      totalVotesInRelevantWaves,
      identityCredit,
      repRatings,
      cardSetCredits
    ] = await Promise.all([
      this.votingDb.getVotersActiveVoteForDrops(
        {
          dropIds: relevantParticipationDropIds,
          voterId: profileId
        },
        {}
      ),
      this.votingDb.getVotersTotalLockedCreditInWaves(
        { waveIds: waveIds, voterId: profileId },
        { connection }
      ),
      needsGlobalIdentityCredit
        ? this.identitiesDb
            .getIdentityByProfileId(profileId, connection)
            .then((identity) => ({
              tdh: identity?.tdh ?? 0,
              xtdh: identity?.xtdh ?? 0
            }))
        : Promise.resolve({ tdh: 0, xtdh: 0 }),
      repWaves.length > 0
        ? this.ratingsDb.getAllProfilesRepRatings(
            profileId,
            hasOnlyOneRestriction
              ? {
                  category: repWaveConditions[0].category ?? undefined,
                  rater_id: repWaveConditions[0].rater_id ?? undefined
                }
              : {},
            connection
          )
        : Promise.resolve([] as Rating[]),
      cardSetCreditNfts.length > 0
        ? this.identitiesDb.getSingleNftVotingCreditsByProfileId(
            profileId,
            cardSetCreditNfts,
            { connection }
          )
        : Promise.resolve({} as Record<string, number>)
    ]);
    const { tdh, xtdh } = identityCredit;
    const wavesById = new Map(
      relevantWavesWithCredits.map((it) => [it.id, it] as const)
    );
    const waveIdsByDropId = new Map(
      relevantParticipationDrops.map((it) => [it.id, it.wave_id])
    );

    return relevantParticipationDropIds.reduce(
      (acc, dropId) => {
        const waveId = waveIdsByDropId.get(dropId);
        if (!waveId) {
          return acc;
        }

        const wave = wavesById.get(waveId);
        const totalVotesInWave = totalVotesInRelevantWaves[waveId];
        const activeVote = activeVotes[dropId];
        if (
          !wave ||
          totalVotesInWave === undefined ||
          activeVote === undefined
        ) {
          return acc;
        }

        const totalCredit = this.getWaveTotalCredit({
          wave,
          repRatings,
          tdh,
          xtdh,
          cardSetCredits
        });
        acc[dropId] = this.getAllowedVoteRange({
          activeVote,
          totalCredit,
          totalVotesInWave,
          perDropLimit: wave.max_votes_per_identity_to_drop
        });
        return acc;
      },
      {} as Record<string, { min: number; current: number; max: number }>
    );
  }

  public async deleteVotes(dropId: string, ctx: RequestContext) {
    await Promise.all([
      this.votingDb.deleteForDrop(dropId, ctx),
      this.votingDb.deleteCreditSpendings(dropId, ctx),
      this.votingDb.deleteDropRanks(dropId, ctx),
      this.votingDb.deleteDropRealVoteInTimes(dropId, ctx),
      this.votingDb.deleteDropRealVoterVoteInTimes(dropId, ctx),
      this.votingDb.deleteDropsLeaderboardEntry(dropId, ctx)
    ]);
  }

  public async deleteVoteByWave(waveId: string, ctx: RequestContext) {
    await Promise.all([
      this.votingDb.deleteForWave(waveId, ctx),
      this.votingDb.deleteCreditSpendingsForWave(waveId, ctx),
      this.votingDb.deleteDropRanksForWave(waveId, ctx),
      this.votingDb.deleteDropRealVoteInTimesForWave(waveId, ctx),
      this.votingDb.deleteWavesLeaderboardEntries(waveId, ctx),
      this.votingDb.deleteDropRealVoterVoteInTimesForWave(waveId, ctx)
    ]);
  }
}

export const dropVotingService = new DropVotingService(
  dropVotingDb,
  identitiesDb,
  wavesApiDb,
  ratingsDb,
  userGroupsService
);
