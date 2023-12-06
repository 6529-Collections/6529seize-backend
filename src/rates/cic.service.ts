import { cicDb, CicDb } from './cic.db';
import { CicStatement, CicStatementGroup } from '../entities/ICICStatement';
import { NotFoundException } from '../exceptions';
import {
  profileActivityLogsDb,
  ProfileActivityLogsDb
} from '../profileActivityLogs/profile-activity-logs.db';
import { ProfileActivityLogType } from '../entities/IProfileActivityLog';

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
    private readonly cicDb: CicDb,
    private readonly profileActivityLogsDb: ProfileActivityLogsDb
  ) {}
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
}

export const cicService = new CicService(cicDb, profileActivityLogsDb);
