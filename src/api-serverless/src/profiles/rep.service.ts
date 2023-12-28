import { ratingsDb, RatingsDb } from '../../../rates/ratings.db';
import { RateMatter } from '../../../entities/IRating';

export class RepService {
  constructor(private readonly ratingsDb: RatingsDb) {}

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

  async getRepForProfile(profileId: string): Promise<number> {
    const foundRatings = await this.ratingsDb.getRatingsForTargetsOnMatters({
      targetIds: [profileId],
      matter: RateMatter.REP
    });
    return foundRatings.at(0)?.rating ?? 0;
  }
}

export const repService = new RepService(ratingsDb);
