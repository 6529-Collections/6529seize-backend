import { ratesService, RatesService } from './rates.service';
import { cicDb, CicDb } from './cic.db';
import { ConnectionWrapper } from '../sql-executor';
import { RateMatterTargetType } from '../entities/IRateMatter';
import { ratesDb, RatesDb } from './rates.db';
import { AggregatedCicRating } from './rates.types';
import { CicStatement, CicStatementGroup } from '../entities/ICICStatement';
import { NotFoundException } from '../exceptions';
import {
  profileActivityLogsDb,
  ProfileActivityLogsDb
} from '../profileActivityLogs/profile-activity-logs.db';
import {
  ProfileActivityLogTargetType,
  ProfileActivityLogType
} from '../entities/IProfileActivityLog';

const CIC_STATEMENT_GROUP_TO_PROFILE_ACTIVITY_LOG_TYPE: Record<
  CicStatementGroup,
  ProfileActivityLogType
> = {
  [CicStatementGroup.CONTACT]: ProfileActivityLogType.CONTACTS_EDIT,
  [CicStatementGroup.SOCIAL_MEDIA_ACCOUNT]: ProfileActivityLogType.SOCIALS_EDIT,
  [CicStatementGroup.SOCIAL_MEDIA_VERIFICATION_POST]:
    ProfileActivityLogType.SOCIAL_VERIFICATION_POST_EDIT
};

export class CicService {
  constructor(
    private readonly ratesService: RatesService,
    private readonly ratesDb: RatesDb,
    private readonly cicDb: CicDb,
    private readonly profileActivityLogsDb: ProfileActivityLogsDb
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
    return await this.cicDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const cicStatement = await this.cicDb.insertCicStatement(
          statement,
          connection
        );
        await this.profileActivityLogsDb.insert(
          {
            profile_id: statement.profile_id,
            target_id: null,
            target_type: null,
            type: CIC_STATEMENT_GROUP_TO_PROFILE_ACTIVITY_LOG_TYPE[
              cicStatement.statement_group
            ],
            contents: JSON.stringify({ action: 'ADD', statement: cicStatement })
          },
          connection
        );
        return cicStatement;
      }
    );
  }

  public async deleteCicStatement(props: { profile_id: string; id: string }) {
    const cicStatement = await this.getCicStatementByIdAndProfileIDOrThrow(
      props
    );
    await this.cicDb.executeNativeQueriesInTransaction(async (connection) => {
      await this.cicDb.deleteCicStatement(props, connection);
      await this.profileActivityLogsDb.insert(
        {
          profile_id: cicStatement.profile_id,
          target_id: null,
          target_type: null,
          type: CIC_STATEMENT_GROUP_TO_PROFILE_ACTIVITY_LOG_TYPE[
            cicStatement.statement_group
          ],
          contents: JSON.stringify({
            action: 'DELETE',
            statement: cicStatement
          })
        },
        connection
      );
    });
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
    if (cicRating !== currentRating) {
      await this.ratesService.registerUserRating({
        raterProfileId,
        matterTargetType: RateMatterTargetType.PROFILE_ID,
        matterTargetId: targetProfileId,
        matter: 'CIC',
        category: 'CIC',
        amount: cicRating - currentRating,
        connectionHolder
      });
      await this.profileActivityLogsDb.insert(
        {
          profile_id: raterProfileId,
          target_id: targetProfileId,
          target_type: ProfileActivityLogTargetType.PROFILE_ID,
          type: ProfileActivityLogType.CIC_RATINGS,
          contents: JSON.stringify({
            oldRating: currentRating,
            newRating: cicRating
          })
        },
        connectionHolder
      );
    }
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

export const cicService = new CicService(
  ratesService,
  ratesDb,
  cicDb,
  profileActivityLogsDb
);
