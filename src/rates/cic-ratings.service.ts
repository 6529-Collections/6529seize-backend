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
    await this.createRatingEvents(
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

  private async createRatingEvents(
    raterProfileId: string,
    targetProfileId: string,
    connectionHolder: ConnectionWrapper<any>,
    cicRating: number
  ) {
    const { positiveTally, negativeTally } =
      await this.getPositiveAndNegativeTallies(
        raterProfileId,
        targetProfileId,
        connectionHolder
      );
    if (cicRating > 0) {
      await this.revokeNegativeAndAdjustPositiveEvents(
        negativeTally,
        raterProfileId,
        targetProfileId,
        cicRating,
        positiveTally,
        connectionHolder
      );
    } else if (cicRating < 0) {
      await this.revokePositiveAndAdjustNegativeEvents(
        positiveTally,
        raterProfileId,
        targetProfileId,
        cicRating,
        negativeTally,
        connectionHolder
      );
    } else {
      await this.revokeAllEvents(
        negativeTally,
        raterProfileId,
        targetProfileId,
        positiveTally,
        connectionHolder
      );
    }
  }

  private async revokeNegativeAndAdjustPositiveEvents(
    negativeTally: number,
    raterProfileId: string,
    targetProfileId: string,
    cicRating: number,
    positiveTally: number,
    connectionHolder: ConnectionWrapper<any>
  ) {
    if (negativeTally > 0) {
      await this.registerNegativeRatingEvent(
        raterProfileId,
        targetProfileId,
        -negativeTally,
        connectionHolder
      );
    }
    await this.registerPositiveRatingEvent(
      raterProfileId,
      targetProfileId,
      cicRating - positiveTally,
      connectionHolder
    );
  }

  private async revokePositiveAndAdjustNegativeEvents(
    positiveTally: number,
    raterProfileId: string,
    targetProfileId: string,
    cicRating: number,
    negativeTally: number,
    connectionHolder: ConnectionWrapper<any>
  ) {
    if (positiveTally > 0) {
      await this.registerPositiveRatingEvent(
        raterProfileId,
        targetProfileId,
        -positiveTally,
        connectionHolder
      );
    }
    await this.registerNegativeRatingEvent(
      raterProfileId,
      targetProfileId,
      Math.abs(cicRating) - negativeTally,
      connectionHolder
    );
  }

  private async revokeAllEvents(
    negativeTally: number,
    raterProfileId: string,
    targetProfileId: string,
    positiveTally: number,
    connectionHolder: ConnectionWrapper<any>
  ) {
    if (negativeTally > 0) {
      await this.registerNegativeRatingEvent(
        raterProfileId,
        targetProfileId,
        -negativeTally,
        connectionHolder
      );
    }
    if (positiveTally > 0) {
      await this.registerPositiveRatingEvent(
        raterProfileId,
        targetProfileId,
        -positiveTally,
        connectionHolder
      );
    }
  }

  private async getPositiveAndNegativeTallies(
    raterProfileId: string,
    targetProfileId: string,
    connectionHolder: ConnectionWrapper<any>
  ) {
    const rateEventTallies =
      await this.ratesDb.getRatesTallyForProfileOnMatterByCategories({
        profileId: raterProfileId,
        matter: 'CIC',
        matterTargetType: RateMatterTargetType.PROFILE_ID,
        matterTargetId: targetProfileId,
        connectionHolder
      });
    const positiveTally = rateEventTallies['POSITIVE'] ?? 0;
    const negativeTally = rateEventTallies['NEGATIVE'] ?? 0;
    return { positiveTally, negativeTally };
  }

  private async registerNegativeRatingEvent(
    raterProfileId: string,
    targetProfileId: string,
    amount: number,
    connectionHolder: ConnectionWrapper<any>
  ) {
    await this.ratesService.registerUserRating({
      raterProfileId,
      matterTargetType: RateMatterTargetType.PROFILE_ID,
      matterTargetId: targetProfileId,
      matter: 'CIC',
      category: 'NEGATIVE',
      amount: amount,
      connectionHolder
    });
  }

  private async registerPositiveRatingEvent(
    raterProfileId: string,
    targetProfileId: string,
    amount: number,
    connectionHolder: ConnectionWrapper<any>
  ) {
    await this.ratesService.registerUserRating({
      raterProfileId,
      matterTargetType: RateMatterTargetType.PROFILE_ID,
      matterTargetId: targetProfileId,
      matter: 'CIC',
      category: 'NEGATIVE',
      amount: amount,
      connectionHolder
    });
  }
}

export const cicRatingsService = new CicRatingsService(
  ratesService,
  ratesDb,
  cicRatingsDb
);
