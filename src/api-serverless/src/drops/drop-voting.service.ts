import {
  BadRequestException,
  ForbiddenException,
  NotFoundException
} from '../../../exceptions';
import { giveReadReplicaTimeToCatchUp } from '../api-helpers';
import { AuthenticationContext } from '../../../auth-context';
import { ApiProfileProxyActionType } from '../../../entities/IProfileProxyAction';
import {
  communityMemberCriteriaService,
  CommunityMemberCriteriaService
} from '../community-members/community-member-criteria.service';
import { dropVotingDb, DropVotingDb } from './drop.voting.db';
import { WaveCreditType, WaveScopeType } from '../../../entities/IWave';
import {
  profileActivityLogsDb,
  ProfileActivityLogsDb
} from '../../../profileActivityLogs/profile-activity-logs.db';
import { ProfileActivityLogType } from '../../../entities/IProfileActivityLog';
import {
  profilesService,
  ProfilesService
} from '../../../profiles/profiles.service';
import { assertUnreachable } from '../../../helpers';

class DropVotingService {
  constructor(
    private readonly profilesService: ProfilesService,
    private readonly communityMemberCriteriaService: CommunityMemberCriteriaService,
    private readonly dropVotingDb: DropVotingDb,
    private readonly profileActivityLogsDb: ProfileActivityLogsDb
  ) {}

  async updateVote({
    authenticationContext,
    drop_id,
    vote
  }: {
    authenticationContext: AuthenticationContext;
    drop_id: string;
    vote: number;
  }) {
    const voterId = authenticationContext.getActingAsId()!;
    if (authenticationContext.isAuthenticatedAsProxy()) {
      const proxyAction =
        authenticationContext.activeProxyActions[
          ApiProfileProxyActionType.RATE_WAVE_DROP
        ];
      if (!proxyAction) {
        throw new ForbiddenException(`You are not eligible to vote on drops`);
      }
    }
    const criteriasVoterIsEligibleFor =
      await this.communityMemberCriteriaService.getCriteriaIdsUserIsEligibleFor(
        voterId
      );

    const dropWave = await this.dropVotingDb.findDropWave(drop_id);
    if (!dropWave) {
      throw new NotFoundException(`Drop ${drop_id} not found`);
    }
    if (
      dropWave.voting_scope_type === WaveScopeType.CURATED &&
      !criteriasVoterIsEligibleFor.includes(dropWave.voting_scope_curation_id!)
    ) {
      throw new ForbiddenException(`You are not eligible to vote on this drop`);
    }

    await this.dropVotingDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const dropVoteBeforeChange = await this.dropVotingDb.lockDropVote(
          { drop_id, voter_id: voterId },
          connection
        );

        const oldVote = dropVoteBeforeChange.vote;
        if (oldVote === vote) {
          throw new BadRequestException(
            `Your vote for this drop is already ${vote}`
          );
        }
        const votingCreditType = dropWave.voting_credit_type;
        switch (votingCreditType) {
          case WaveCreditType.TDH: {
            await this.assertProfileHasEnoughTDHToVoteForDrop({
              oldVote,
              newVote: vote,
              voterId: voterId
            });
            break;
          }
          case WaveCreditType.REP: {
            await this.assertProfileHasEnoughRepToVoteForDrop({
              oldVote,
              newVote: vote,
              voterId: voterId,
              repCategory: dropWave.voting_credit_category,
              repCreditor: dropWave.voting_credit_creditor
            });
            break;
          }
          case WaveCreditType.UNIQUE: {
            if (Math.abs(vote) > 1) {
              throw new BadRequestException(
                `Votes larger than 1 are not allowed for this drop`
              );
            }
            break;
          }
          default:
            assertUnreachable(votingCreditType);
        }

        await this.dropVotingDb.updateDropVote(
          { id: dropVoteBeforeChange.id, vote },
          connection
        );
        await this.profileActivityLogsDb.insert(
          {
            profile_id: voterId,
            contents: JSON.stringify({
              old_vote: dropVoteBeforeChange.drop_id,
              new_vote: vote
            }),
            target_id: drop_id,
            type: ProfileActivityLogType.DROP_VOTED,
            proxy_id: authenticationContext.isAuthenticatedAsProxy()
              ? authenticationContext.authenticatedProfileId
              : null
          },
          connection
        );
        await this.dropVotingDb.insertVoteChange(
          { voterId, dropId: drop_id, change: vote - oldVote },
          connection
        );
      }
    );
    await giveReadReplicaTimeToCatchUp();
  }

  private async assertProfileHasEnoughTDHToVoteForDrop(param: {
    newVote: number;
    oldVote: number;
    voterId: string;
  }) {
    const { newVote, oldVote, voterId } = param;
    const profileTdh = await this.profilesService.getProfileTdh(voterId);
    const tdhAfterVote = profileTdh - Math.abs(oldVote) + Math.abs(newVote);
    if (tdhAfterVote < 0) {
      throw new ForbiddenException(
        `You do not have enough TDH to give this vote`
      );
    }
  }

  private async assertProfileHasEnoughRepToVoteForDrop(param: {
    newVote: number;
    oldVote: number;
    voterId: string;
    repCategory: string | null;
    repCreditor: string | null;
  }) {
    const { newVote, oldVote, voterId, repCategory, repCreditor } = param;
    const rep = await this.profilesService.getProfileRep({
      repCategory,
      repCreditor,
      profileId: voterId
    });
    const repAfterVote = rep - Math.abs(oldVote) + Math.abs(newVote);
    if (repAfterVote < 0) {
      throw new ForbiddenException(
        `You do not have enough credit to give this vote`
      );
    }
  }
}

export const dropVotingService = new DropVotingService(
  profilesService,
  communityMemberCriteriaService,
  dropVotingDb,
  profileActivityLogsDb
);
