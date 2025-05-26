import { ratingsDb, RatingsDb } from '../../../rates/ratings.db';
import { RateMatter } from '../../../entities/IRating';
import { ConnectionWrapper } from '../../../sql-executor';

export class RepService {
  constructor(private readonly ratingsDb: RatingsDb) {}

  async getRepForProfiles(
    profileIds: string[],
    connection?: ConnectionWrapper<any>
  ): Promise<Record<string, number>> {
    const foundRatings = await this.ratingsDb.getRatingsForTargetsOnMatters(
      {
        targetIds: profileIds,
        matter: RateMatter.REP
      },
      connection
    );
    return profileIds.reduce(
      (acc, profileId) => {
        return {
          ...acc,
          [profileId]:
            foundRatings.find((rating) => rating.matter_target_id === profileId)
              ?.rating ?? 0
        };
      },
      {} as Record<string, number>
    );
  }
}

export const repService = new RepService(ratingsDb);
