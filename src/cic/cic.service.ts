import { cicDb, CicDb } from './cic.db';
import { CicStatement, CicStatementGroup } from '../entities/ICICStatement';
import { BadRequestException, NotFoundException } from '../exceptions';
import { profileActivityLogsDb } from '../profileActivityLogs/profile-activity-logs.db';
import { ProfileActivityLogType } from '../entities/IProfileActivityLog';
import { ConnectionWrapper } from '../sql-executor';
import {
  abusivenessCheckService,
  AbusivenessCheckService
} from '../profiles/abusiveness-check.service';
import { ProfileClassification } from '../entities/IProfile';

const CIC_STATEMENT_GROUP_TO_PROFILE_ACTIVITY_LOG_TYPE: Record<
  CicStatementGroup,
  ProfileActivityLogType
> = {
  [CicStatementGroup.CONTACT]: ProfileActivityLogType.CONTACTS_EDIT,
  [CicStatementGroup.SOCIAL_MEDIA_ACCOUNT]: ProfileActivityLogType.SOCIALS_EDIT,
  [CicStatementGroup.GENERAL]:
    ProfileActivityLogType.GENERAL_CIC_STATEMENT_EDIT,
  [CicStatementGroup.NFT_ACCOUNTS]: ProfileActivityLogType.NFT_ACCOUNTS_EDIT,
  [CicStatementGroup.SOCIAL_MEDIA_VERIFICATION_POST]:
    ProfileActivityLogType.SOCIAL_VERIFICATION_POST_EDIT
};

export class CicService {
  private readonly socialsRules: Record<
    string,
    { regexp: RegExp; errorMessageIfNotValid: string }
  > = {
    X: {
      regexp: /^https:\/\/(www\.)?(x|twitter)\.com\/[a-zA-Z0-9_]{3,15}$/,
      errorMessageIfNotValid:
        'X needs to start with https://x.com/ or https://twitter.com/ and the handle must be 3 to 15 characters long containing only letters, numbers, and underscores'
    },
    FACEBOOK: {
      regexp: /^https:\/\/(www\.)?facebook\.com\/(.)+/,
      errorMessageIfNotValid:
        'Facebook needs go start with https://www.facebook.com/'
    },
    LINKED_IN: {
      regexp: /^https:\/\/(www\.)?(linkedin\.com|linked\.in)\/(.)+/,
      errorMessageIfNotValid:
        'LinkedIn needs go start with https://www.linkedin.com/ or https://linked.in/'
    },
    INSTAGRAM: {
      regexp: /^https:\/\/(www\.)?instagram\.com\/(.)+/,
      errorMessageIfNotValid:
        'Instagram needs go start with https://www.instagram.com/'
    },
    TIK_TOK: {
      regexp: /^https:\/\/(www\.)?tiktok\.com\/@(.)+/,
      errorMessageIfNotValid:
        'TikTok needs go start with https://www.tiktok.com/@'
    },
    GITHUB: {
      regexp: /^https:\/\/(www\.)?github\.com\/(.)+/,
      errorMessageIfNotValid:
        'GitHub needs go start with https://www.github.com/'
    },
    REDDIT: {
      regexp: /^https:\/\/(www\.)?reddit\.com\/([ru])\/(.)+/,
      errorMessageIfNotValid:
        'Reddit needs go start with https://www.reddit.com/ followed by /r/ or /u/ and subreddit or username'
    },
    WEIBO: {
      regexp: /^https:\/\/(www\.)?weibo\.com\/(.)+/,
      errorMessageIfNotValid: 'Weibo needs go start with https://www.weibo.com/'
    },
    SUBSTACK: {
      regexp: /^https:\/\/(.)+\.substack\.com(\/)?$/,
      errorMessageIfNotValid:
        'Substack needs to be https://yourusername.substack.com/'
    },
    MEDIUM: {
      regexp: /^https:\/\/(www\.)?medium\.com\/@(.)+/,
      errorMessageIfNotValid:
        'Medium needs to start with https://www.medium.com/@'
    },
    MIRROR_XYZ: {
      regexp: /^https:\/\/(www\.)?mirror\.xyz\/(.)+/,
      errorMessageIfNotValid:
        'Mirror needs to start with https://www.mirror.xyz/'
    },
    YOUTUBE: {
      regexp: /^https:\/\/(www\.)?youtube\.com\/(.)+/,
      errorMessageIfNotValid:
        'Youtube needs to start with https://www.youtube.com/'
    },
    DISCORD: {
      regexp: /^.{1,50}$/,
      errorMessageIfNotValid: 'Discord needs to be less than 50 characters'
    },
    TELEGRAM: {
      regexp: /^.{1,100}$/,
      errorMessageIfNotValid: 'Telegram needs to be less than 100 characters'
    },
    WECHAT: {
      regexp: /^.{1,100}$/,
      errorMessageIfNotValid: 'WeChat needs to be less than 100 characters'
    },
    EMAIL: {
      regexp:
        /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
      errorMessageIfNotValid: 'Email is not valid'
    },
    WEBSITE: {
      regexp: /^http(s)?:\/\/.{1,2000}$/,
      errorMessageIfNotValid:
        "Website needs to start with http or https and URL can't be longer than 2000 characters"
    },
    LINK: {
      regexp: /^http(s)?:\/\/.{1,2000}$/,
      errorMessageIfNotValid:
        "Link needs to start with http or https and URL can't be longer than 2000 characters"
    },
    SUPER_RARE: {
      regexp: /^https:\/\/(www\.)?superrare\.com\/(.)+/,
      errorMessageIfNotValid:
        'SuperRare needs to start with https://www.superrare.com/'
    },
    FOUNDATION: {
      regexp: /^https:\/\/(www\.)?foundation\.app\/(.)+/,
      errorMessageIfNotValid:
        'Foundation needs to start with https://www.foundation.app/'
    },
    MAKERS_PLACE: {
      regexp: /^https:\/\/(www\.)?makersplace\.com\/(.)+/,
      errorMessageIfNotValid:
        'MakersPlace needs to start with https://www.makersplace.com/'
    },
    KNOWN_ORIGIN: {
      regexp: /^https:\/\/(www\.)?knownorigin\.io\/(.)+/,
      errorMessageIfNotValid:
        'KnownOrigin needs to start with https://www.knownorigin.io/'
    },
    PEPE_WTF: {
      regexp: /^https:\/\/(www\.)?pepe\.wtf\/(.)+/,
      errorMessageIfNotValid:
        'Pepe.wtf needs to start with https://www.pepe.wtf/'
    },
    OPENSEA: {
      regexp: /^https:\/\/(www\.)?opensea\.io\/(.)+/,
      errorMessageIfNotValid:
        'OpenSea needs to start with https://www.opensea.io/'
    },
    ART_BLOCKS: {
      regexp: /^https:\/\/(www\.)?artblocks\.io\/(.)+/,
      errorMessageIfNotValid:
        'Art Blocks needs to start with https://www.artblocks.io/'
    },
    DECA_ART: {
      regexp: /^https:\/\/(www\.)?deca\.art\/(.)+/,
      errorMessageIfNotValid:
        'Deca Art needs to start with https://www.deca.art/'
    },
    ON_CYBER: {
      regexp: /^https:\/\/(www\.)?oncyber\.io\/(.)+/,
      errorMessageIfNotValid:
        'OnCyber needs to start with https://www.oncyber.io/'
    },
    THE_LINE: {
      regexp: /^https:\/\/(www\.)?oncyber\.io\/line(.)+/,
      errorMessageIfNotValid:
        'The Line needs to start with https://www.oncyber.io/line'
    }
  };

  constructor(
    private readonly cicDb: CicDb,
    private readonly abusivenessCheckService: AbusivenessCheckService
  ) {}

  public async getCicStatementByIdAndProfileIdOrThrow(props: {
    profile_id: string;
    id: string;
  }): Promise<CicStatement> {
    const cicStatement =
      await this.cicDb.getCicStatementByIdAndProfileId(props);
    if (!cicStatement) {
      throw new NotFoundException(
        `CIC statement ${props.id} not found for profile ${props.profile_id}`
      );
    }
    return cicStatement;
  }

  async getCicStatementsByProfileId(
    profile_id: string,
    connection?: ConnectionWrapper<any>
  ): Promise<CicStatement[]> {
    return this.cicDb.getCicStatementsByProfileId(profile_id, connection);
  }

  private validateCicStatement({
    statement_type,
    statement_value
  }: {
    statement_type: string;
    statement_value: string;
  }) {
    const rule = this.socialsRules[statement_type];
    if (rule) {
      const regexp = rule.regexp;
      if (!regexp.test(statement_value)) {
        throw new BadRequestException(rule.errorMessageIfNotValid);
      }
    } else if (statement_value.length > 500) {
      throw new BadRequestException(
        `Statement of type ${statement_type} can not be longer than 500 characters`
      );
    }
  }

  public async addCicStatement({
    statement,
    profile
  }: {
    statement: Omit<CicStatement, 'id' | 'crated_at' | 'updated_at'>;
    profile: {
      handle: string;
      profile_id: string;
      classification: ProfileClassification | null;
    };
  }) {
    this.validateCicStatement(statement);
    return await this.cicDb.executeNativeQueriesInTransaction(
      async (connection) => {
        const existingStatements = await this.cicDb.getCicStatementsByProfileId(
          statement.profile_id,
          connection
        );
        const preexistingStatement = existingStatements.find(
          (existingStatement) =>
            existingStatement.statement_type === statement.statement_type &&
            existingStatement.statement_value === statement.statement_value
        );
        if (
          statement.statement_group === CicStatementGroup.GENERAL &&
          statement.statement_type === 'BIO'
        ) {
          const abusivenessDetectionResult =
            await this.abusivenessCheckService.checkBio({
              handle: profile.handle,
              profile_type:
                profile.classification ?? ProfileClassification.PSEUDONYM,
              text: statement.statement_value
            });
          if (abusivenessDetectionResult.status === 'DISALLOWED') {
            throw new BadRequestException(
              `Bio is not allowed: ${abusivenessDetectionResult.explanation}`
            );
          }
          const existingBioStatement = existingStatements.find(
            (existingStatement) => existingStatement.statement_type === 'BIO'
          );
          if (existingBioStatement) {
            await this.deleteStatement(existingBioStatement, connection);
          }
        } else if (preexistingStatement) {
          throw new BadRequestException(
            `Statement of type ${statement.statement_type} with value ${statement.statement_value} already exists`
          );
        }
        return await this.insertStatement(statement, connection);
      }
    );
  }

  public async insertStatement(
    statement: Omit<CicStatement, 'id' | 'crated_at' | 'updated_at'>,
    connection: ConnectionWrapper<any>,
    skipLogCreation?: boolean
  ) {
    const cicStatement = await this.cicDb.insertCicStatement(
      statement,
      connection
    );
    if (!skipLogCreation) {
      await profileActivityLogsDb.insert(
        {
          profile_id: statement.profile_id,
          target_id: null,
          type: CIC_STATEMENT_GROUP_TO_PROFILE_ACTIVITY_LOG_TYPE[
            cicStatement.statement_group
          ],
          contents: JSON.stringify({ action: 'ADD', statement: cicStatement }),
          proxy_id: null,
          additional_data_1: null,
          additional_data_2: null
        },
        connection
      );
    }
    return cicStatement;
  }

  public async deleteCicStatement(props: { profile_id: string; id: string }) {
    const cicStatement =
      await this.getCicStatementByIdAndProfileIdOrThrow(props);
    await this.cicDb.executeNativeQueriesInTransaction(async (connection) => {
      await this.deleteStatement(cicStatement, connection);
    });
  }

  public async deleteStatement(
    cicStatement: CicStatement,
    connection: ConnectionWrapper<any>,
    skipLogCreation?: boolean
  ) {
    await this.cicDb.deleteCicStatement(
      { id: cicStatement.id, profile_id: cicStatement.profile_id },
      connection
    );
    if (!skipLogCreation) {
      await profileActivityLogsDb.insert(
        {
          profile_id: cicStatement.profile_id,
          target_id: null,
          type: CIC_STATEMENT_GROUP_TO_PROFILE_ACTIVITY_LOG_TYPE[
            cicStatement.statement_group
          ],
          contents: JSON.stringify({
            action: 'DELETE',
            statement: cicStatement
          }),
          proxy_id: null,
          additional_data_1: null,
          additional_data_2: null
        },
        connection
      );
    }
  }
}

export const cicService = new CicService(cicDb, abusivenessCheckService);
