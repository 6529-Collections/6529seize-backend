import { ratingsDb, RatingsDb } from '../../../rates/ratings.db';
import { RateMatter } from '../../../entities/IRating';
import {
  repScoreAggregationDb,
  RepScoreAggregationDb
} from '../../../aggregations/rep-score-aggregation.db';

export class RepService {
  constructor(
    private readonly ratingsDb: RatingsDb,
    private readonly repScoreAggregationDb: RepScoreAggregationDb
  ) {}

  async getRepForProfiles(
    profileIds: string[]
  ): Promise<Record<string, number>> {
    const foundRatings = await this.ratingsDb.getRatingsForTargetsOnMatters({
      targetIds: profileIds,
      matter: RateMatter.REP
    });
    return profileIds.reduce((acc, profileId) => {
      return {
        ...acc,
        [profileId]:
          foundRatings.find((rating) => rating.matter_target_id === profileId)
            ?.rating ?? 0
      };
    }, {} as Record<string, number>);
  }

  async getAggregatedRepForProfiles(
    profileIds: string[]
  ): Promise<Record<string, number>> {
    const data = await this.repScoreAggregationDb.getDataForProfiles(
      profileIds
    );
    return profileIds.reduce(
      (acc, profileId) => ({
        ...acc,
        [profileId]: data.find((it) => it.profile_id === profileId)?.score ?? 0
      }),
      {} as Record<string, number>
    );
  }

  async getRepForProfile(profileId: string): Promise<number> {
    const foundRatings = await this.ratingsDb.getRatingsForTargetsOnMatters({
      targetIds: [profileId],
      matter: RateMatter.REP
    });
    return foundRatings.at(0)?.rating ?? 0;
  }
}

export const repService = new RepService(ratingsDb, repScoreAggregationDb);
