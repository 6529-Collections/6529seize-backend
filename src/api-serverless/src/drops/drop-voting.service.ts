import { RequestContext } from '../../../request.context';
import { identitiesDb, IdentitiesDb } from '../../../identities/identities.db';
import { wavesApiDb, WavesApiDb } from '../waves/waves.api.db';
import {
  userGroupsService,
  UserGroupsService
} from '../community-members/user-groups.service';
import { DropEntity, DropType } from '../../../entities/IDrop';
import { DropVotingDb, dropVotingDb } from './drop-voting.db';
import { WaveCreditType } from '../../../entities/IWave';
import { ConnectionWrapper } from '../../../sql-executor';
import { distinct } from '../../../helpers';
import { ratingsDb, RatingsDb } from '../../../rates/ratings.db';
import { Rating } from '../../../entities/IRating';

export class DropVotingService {
  constructor(
    private readonly votingDb: DropVotingDb,
    private readonly identitiesDb: IdentitiesDb,
    private readonly wavesDb: WavesApiDb,
    private readonly ratingsDb: RatingsDb,
    private readonly userGroupsService: UserGroupsService
  ) {}

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
    const relevantWaveIds = distinct(
      participationDrops.map((drop) => drop.wave_id)
    );
    const relevantWaves = await this.wavesDb.findWavesByIds(
      relevantWaveIds,
      groupIdsUserIsEligibleFor,
      connection
    );
    const wavesIdsWhereVotingIsImplemented = relevantWaves
      .filter((it) => {
        return it.time_lock_ms === null || it.time_lock_ms === 0;
      })
      .map((it) => it.id);
    const relevantParticipationDrops = participationDrops.filter((drop) =>
      wavesIdsWhereVotingIsImplemented.includes(drop.wave_id)
    );
    const relevantParticipationDropIds = relevantParticipationDrops.map(
      (it) => it.id
    );
    const repWaves = relevantWaves.filter(
      (it) => it.voting_credit_type === WaveCreditType.REP
    );
    const repWaveConditions = repWaves
      .map((it) => ({
        category: it.voting_credit_category,
        rater_id: it.voting_credit_creditor
      }))
      .filter((it) => it.rater_id !== null || it.category !== null);
    const hasOnlyOneRestriction =
      distinct(repWaveConditions.map((it) => `${it.category}-${it.rater_id}`))
        .length === 1;
    const [activeVotes, totalVotesInRelevantWaves, tdh, repRatings] =
      await Promise.all([
        this.votingDb.getVotersActiveVoteForDrops(
          {
            dropIds: relevantParticipationDropIds,
            voterId: profileId
          },
          {}
        ),
        this.votingDb.getVotersTotalVotesInWaves(
          { waveIds: wavesIdsWhereVotingIsImplemented, voterId: profileId },
          { connection }
        ),
        this.identitiesDb
          .getIdentityByProfileId(profileId)
          ?.then((identity) => identity?.tdh ?? 0),
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
          : Promise.resolve([] as Rating[])
      ]);
    return relevantParticipationDropIds.reduce((acc, dropId) => {
      const waveId = relevantParticipationDrops.find(
        (it) => it.id === dropId
      )?.wave_id;
      if (waveId) {
        const wave = relevantWaves.find((it) => it.id === waveId)!;
        const waveVotingCreditType = wave.voting_credit_type;
        const totalCredit =
          waveVotingCreditType === WaveCreditType.TDH
            ? tdh
            : repRatings
                .filter(
                  (it) =>
                    (wave.voting_credit_creditor === null ||
                      wave.voting_credit_creditor === it.rater_profile_id) &&
                    (wave.voting_credit_category === null ||
                      wave.voting_credit_category === it.matter_category)
                )
                .reduce((acc, it) => acc + it.rating, 0);
        const totalVotesInWave = totalVotesInRelevantWaves[waveId];
        const activeVote = activeVotes[dropId];
        if (totalVotesInWave !== undefined && activeVote !== undefined) {
          const creditLeft = Math.max(0, totalCredit - totalVotesInWave);
          if (activeVote < 0) {
            acc[dropId] = {
              min: -(creditLeft - activeVote),
              current: activeVote,
              max: -activeVote + creditLeft
            };
          } else if (activeVote > 0) {
            acc[dropId] = {
              min: -activeVote - creditLeft,
              current: activeVote,
              max: activeVote + creditLeft
            };
          } else {
            acc[dropId] = {
              min: creditLeft,
              current: activeVote,
              max: -creditLeft
            };
          }
        }
      }
      return acc;
    }, {} as Record<string, { min: number; current: number; max: number }>);
  }

  public async deleteVotes(dropId: string, ctx: RequestContext) {
    await Promise.all([
      this.votingDb.deleteForDrop(dropId, ctx),
      this.votingDb.deleteCreditSpendings(dropId, ctx),
      this.votingDb.deleteDropRanks(dropId, ctx)
    ]);
  }

  public async deleteVoteByWave(waveId: string, ctx: RequestContext) {
    await Promise.all([
      this.votingDb.deleteForWave(waveId, ctx),
      this.votingDb.deleteCreditSpendingsForWave(waveId, ctx),
      this.votingDb.deleteDropRanksForWave(waveId, ctx)
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
