import { ratesService, RatesService } from './rates.service';
import { cicDb, CicDb } from './cic.db';
import { ConnectionWrapper } from '../sql-executor';
import { RateMatterTargetType } from '../entities/IRateMatter';
import { ratesDb, RatesDb } from './rates.db';
import { AggregatedCicRating } from './rates.types';
import { CicStatement } from '../entities/ICICStatement';
import { NotFoundException } from '../exceptions';

export class CicService {
  constructor(
    private readonly ratesService: RatesService,
    private readonly ratesDb: RatesDb,
    private readonly cicDb: CicDb
  ) {}

  public async getProfileCicRating(
    profileId: string
  ): Promise<AggregatedCicRating> {
    const result = await this.cicDb.getAggregatedCicRatingForProfile(profileId);
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
    return this.cicDb.getProfilesAggregatedCicRatingForProfile(
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
    await this.cicDb.executeNativeQueriesInTransaction(
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

  public async getCicStatementByIdAndProfileIDOrThrow(props: {
    profile_id: string;
    id: string;
  }): Promise<CicStatement> {
    const cicStatement = await this.cicDb.getCicStatementByIdAndProfileId(
      props
    );
    if (!cicStatement) {
      throw new NotFoundException(
        `CIC statement ${props.id} not found for profile ${props.profile_id}`
      );
    }
    return cicStatement;
  }

  async getCicStatementsByProfileId(
    profile_id: string
  ): Promise<CicStatement[]> {
    return this.cicDb.getCicStatementsByProfileId(profile_id);
  }

  public async addCicStatement(
    statement: Omit<CicStatement, 'id' | 'crated_at' | 'updated_at'>
  ) {
    return this.cicDb.insertCicStatement(statement);
  }

  public async updateCicStatement(
    statement: Omit<CicStatement, 'crated_at' | 'updated_at'>
  ) {
    await this.getCicStatementByIdAndProfileIDOrThrow({
      id: statement.id,
      profile_id: statement.profile_id
    });
    return this.cicDb.updateCicStatement(statement);
  }

  public async deleteCicStatement(props: { profile_id: string; id: string }) {
    await this.getCicStatementByIdAndProfileIDOrThrow(props);
    await this.cicDb.deleteCicStatement(props);
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
    await this.cicDb.lockCicRating({
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
    await this.cicDb.updateCicRating({
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

export const cicService = new CicService(ratesService, ratesDb, cicDb);
