import { ratesService, RatesService } from './rates.service';
import { cicRatingsDb, CicRatingsDb } from './cic-ratings.db';
import { ConnectionWrapper } from '../sql-executor';
import { RateMatterTargetType } from '../entities/IRateMatter';
import { ratesDb, RatesDb } from './rates.db';
import { AggregatedCicRating } from './rates.types';

export class CicRatingsService {
  constructor(
    private readonly ratesService: RatesService,
    private readonly ratesDb: RatesDb,
    private readonly cicRatingsDb: CicRatingsDb
  ) {}

  public async getProfileCicRating(
    profileId: string
  ): Promise<AggregatedCicRating> {
    const result = await this.cicRatingsDb.getAggregatedCicRatingForProfile(
      profileId
    );
    if (result === null) {
      return {
        cic_rating: 0,
        contributor_count: 0
      };
    }
    return result;
  }

  public async getProfilesAggregatedCicRatingForProfile(
    targetProfileId: string,
    raterProfileId: string
  ): Promise<number> {
    return this.cicRatingsDb.getProfilesAggregatedCicRatingForProfile(
      targetProfileId,
      raterProfileId
    );
  }

  public async getCicRatesLeftForProfile(profileId: string): Promise<number> {
    const { ratesLeft } =
      await this.ratesService.getRatesLeftOnMatterForProfile({
        profileId,
        matter: 'CIC',
        matterTargetType: RateMatterTargetType.PROFILE_ID
      });
    return ratesLeft;
  }

  public async updateProfileCicRating({
    raterProfileId,
    targetProfileId,
    cicRating
  }: {
    raterProfileId: string;
    targetProfileId: string;
    cicRating: number;
  }) {
    await this.cicRatingsDb.executeNativeQueriesInTransaction(
      async (connectionHolder) => {
        await this.updateProfileCicRatingInGivenTransaction({
          raterProfileId,
          targetProfileId,
          cicRating,
          connectionHolder
        });
      }
    );
  }

  private async updateProfileCicRatingInGivenTransaction({
    raterProfileId,
    targetProfileId,
    cicRating,
    connectionHolder
  }: {
    raterProfileId: string;
    targetProfileId: string;
    cicRating: number;
    connectionHolder: ConnectionWrapper<any>;
  }) {
    await this.cicRatingsDb.lockCicRating({
      raterProfileId,
      targetProfileId,
      connectionHolder
    });
    await this.createRatingEvent(
      raterProfileId,
      targetProfileId,
      connectionHolder,
      cicRating
    );
    await this.cicRatingsDb.updateCicRating({
      raterProfileId,
      targetProfileId,
      cicRating,
      connectionHolder
    });
  }

  private async createRatingEvent(
    raterProfileId: string,
    targetProfileId: string,
    connectionHolder: ConnectionWrapper<any>,
    cicRating: number
  ) {
    const currentRating = await this.getProfileCurrentRatingOnProfile(
      raterProfileId,
      targetProfileId,
      connectionHolder
    );
    await this.ratesService.registerUserRating({
      raterProfileId,
      matterTargetType: RateMatterTargetType.PROFILE_ID,
      matterTargetId: targetProfileId,
      matter: 'CIC',
      category: 'CIC',
      amount: cicRating - currentRating,
      connectionHolder
    });
  }

  private async getProfileCurrentRatingOnProfile(
    raterProfileId: string,
    targetProfileId: string,
    connectionHolder: ConnectionWrapper<any>
  ): Promise<number> {
    return this.ratesDb.getTotalRatesTallyOnMatterByProfileId({
      profileId: raterProfileId,
      matter: 'CIC',
      matterTargetType: RateMatterTargetType.PROFILE_ID,
      matterTargetId: targetProfileId,
      connectionHolder
    });
  }
}

export const cicRatingsService = new CicRatingsService(
  ratesService,
  ratesDb,
  cicRatingsDb
);
