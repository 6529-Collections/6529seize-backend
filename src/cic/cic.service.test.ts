import { CicDb } from './cic.db';
import { ProfileActivityLogsDb } from '../profileActivityLogs/profile-activity-logs.db';
import { CicService } from './cic.service';
import { mock, Mock } from 'ts-jest-mocker';
import { CicStatementGroup } from '../entities/ICICStatement';
import {
  expectExceptionWithMessage,
  mockConnection,
  mockDbService
} from '../tests/test.helper';
import { when } from 'jest-when';
import { uniqueShortId } from '../helpers';
import { ProfileActivityLogType } from '../entities/IProfileActivityLog';
import { AbusivenessCheckService } from '../profiles/abusiveness-check.service';
import { ProfileClassification } from '../entities/IProfile';

const aProfile = {
  handle: 'Joe',
  classification: ProfileClassification.PSEUDONYM,
  profile_id: 'pid'
};

describe('CicService', () => {
  let cicDb: Mock<CicDb>;
  let profileActivityLogsDb: Mock<ProfileActivityLogsDb>;
  let abusivenessCheckService: Mock<AbusivenessCheckService>;
  let cicService: CicService;

  beforeEach(() => {
    cicDb = mockDbService();
    profileActivityLogsDb = mockDbService();
    abusivenessCheckService = mock(AbusivenessCheckService);
    cicService = new CicService(
      cicDb,
      profileActivityLogsDb,
      abusivenessCheckService
    );
  });

  describe('getCicStatementByIdAndProfileIdOrThrow', () => {
    it('throws NotFoundException if cic statement is not found', async () => {
      await expectExceptionWithMessage(async () => {
        await cicService.getCicStatementByIdAndProfileIdOrThrow({
          id: 'sid',
          profile_id: 'pid'
        });
      }, `CIC statement sid not found for profile pid`);
    });

    it('returns cic statement if found', async () => {
      const cicStatement = {
        id: 'sid',
        profile_id: 'pid',
        statement_group: CicStatementGroup.SOCIAL_MEDIA_ACCOUNT,
        statement_type: 'FACEBOOK',
        statement_value: 'https://www.facebook.com/username',
        statement_comment: 'a comment',
        crated_at: new Date()
      };
      when(cicDb.getCicStatementByIdAndProfileId)
        .calledWith({ id: 'sid', profile_id: 'pid' })
        .mockResolvedValue(cicStatement);
      const foundStatement =
        await cicService.getCicStatementByIdAndProfileIdOrThrow({
          id: 'sid',
          profile_id: 'pid'
        });
      expect(foundStatement).toEqual(cicStatement);
    });
  });

  describe('deleteCicStatement', () => {
    it('throws NotFoundException if cic statement is not found', async () => {
      await expectExceptionWithMessage(async () => {
        await cicService.deleteCicStatement({
          id: 'sid',
          profile_id: 'pid'
        });
      }, `CIC statement sid not found for profile pid`);
    });

    it('deletes cic statement if found', async () => {
      const cicStatement = {
        id: 'sid',
        profile_id: 'pid',
        statement_group: CicStatementGroup.SOCIAL_MEDIA_ACCOUNT,
        statement_type: 'FACEBOOK',
        statement_value: 'https://www.facebook.com/username',
        statement_comment: 'a comment',
        crated_at: new Date()
      };
      when(cicDb.getCicStatementByIdAndProfileId)
        .calledWith({ id: 'sid', profile_id: 'pid' })
        .mockResolvedValue(cicStatement);
      await cicService.deleteCicStatement({
        id: 'sid',
        profile_id: 'pid'
      });
      expect(cicDb.deleteCicStatement).toHaveBeenCalledWith(
        { id: 'sid', profile_id: 'pid' },
        mockConnection
      );
    });
  });

  describe('addCicStatement', () => {
    const aProfileId = 'a_profile_id';

    beforeEach(() => {
      when(cicDb.insertCicStatement).mockImplementation(async (statement) => ({
        id: uniqueShortId(),
        ...statement,
        crated_at: new Date()
      }));
      when(cicDb.getCicStatementsByProfileId)
        .calledWith(aProfileId, mockConnection)
        .mockResolvedValue([]);
    });

    describe('statement type is X', () => {
      const aNewXCicStatement = {
        profile_id: aProfileId,
        statement_group: CicStatementGroup.SOCIAL_MEDIA_ACCOUNT,
        statement_type: 'X',
        statement_value: 'https://www.x.com/username',
        statement_comment: 'a comment'
      };

      it('validation fails if domain is neither x.com nor twitter.com', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewXCicStatement,
              statement_value: 'https://www.y.com/username'
            }
          });
        }, 'X needs to start with https://x.com/ or https://twitter.com/ and the handle must be 3 to 15 characters long containing only letters, numbers, and underscores');
      });

      it('validation fails without https:// beginning', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewXCicStatement,
              statement_value: 'www.x.com/username'
            }
          });
        }, 'X needs to start with https://x.com/ or https://twitter.com/ and the handle must be 3 to 15 characters long containing only letters, numbers, and underscores');
      });

      it('validation fails if handle is less than 3 characters', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewXCicStatement,
              statement_value: 'https://www.x.com/us'
            }
          });
        }, 'X needs to start with https://x.com/ or https://twitter.com/ and the handle must be 3 to 15 characters long containing only letters, numbers, and underscores');
      });

      it('validation fails if handle is longer than 15 characters', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewXCicStatement,
              statement_value: 'https://www.x.com/abnormally_long_'
            }
          });
        }, 'X needs to start with https://x.com/ or https://twitter.com/ and the handle must be 3 to 15 characters long containing only letters, numbers, and underscores');
      });

      it('validation fails if handle contanins special characters', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewXCicStatement,
              statement_value: 'https://www.x.com/user$name'
            }
          });
        }, 'X needs to start with https://x.com/ or https://twitter.com/ and the handle must be 3 to 15 characters long containing only letters, numbers, and underscores');
      });

      it('validation passes with www.x.com domain and correct handle', async () => {
        await cicService.addCicStatement({
          profile: aProfile,
          statement: {
            ...aNewXCicStatement,
            statement_value: 'https://www.x.com/username'
          }
        });
      });

      it('validation passes with www.twitter.com domain and correct handle', async () => {
        await cicService.addCicStatement({
          profile: aProfile,
          statement: {
            ...aNewXCicStatement,
            statement_value: 'https://www.twitter.com/username'
          }
        });
      });

      it('validation passes without www. in front of domain', async () => {
        await cicService.addCicStatement({
          profile: aProfile,
          statement: {
            ...aNewXCicStatement,
            statement_value: 'https://x.com/username'
          }
        });
      });
    });

    describe('statement type is FACEBOOK', () => {
      const aNewFacebookCicStatement = {
        profile_id: aProfileId,
        statement_group: CicStatementGroup.SOCIAL_MEDIA_ACCOUNT,
        statement_type: 'FACEBOOK',
        statement_value: 'https://www.facebook.com/username',
        statement_comment: 'a comment'
      };

      it('validation fails without https:// beginning', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewFacebookCicStatement,
              statement_value: 'www.facebook.com/username'
            }
          });
        }, 'Facebook needs go start with https://www.facebook.com/');
      });

      it('validation fails if domain is not www.facebook.com', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewFacebookCicStatement,
              statement_value: 'https://www.facetook.com/username'
            }
          });
        }, 'Facebook needs go start with https://www.facebook.com/');
      });

      it('validation fails if there is nothing following www.facebook.com', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewFacebookCicStatement,
              statement_value: 'https://www.facebook.com/'
            }
          });
        }, 'Facebook needs go start with https://www.facebook.com/');
      });

      it('validation passes with www.facebook.com followed by something', async () => {
        await cicService.addCicStatement({
          profile: aProfile,
          statement: {
            ...aNewFacebookCicStatement,
            statement_value: 'https://www.facebook.com/username'
          }
        });
      });

      it('validation passes without www. in front of domain', async () => {
        await cicService.addCicStatement({
          profile: aProfile,
          statement: {
            ...aNewFacebookCicStatement,
            statement_value: 'https://facebook.com/username'
          }
        });
      });
    });

    describe('statement type is LinkedIn', () => {
      const aNewLinkedInCicStatement = {
        profile_id: aProfileId,
        statement_group: CicStatementGroup.SOCIAL_MEDIA_ACCOUNT,
        statement_type: 'LINKED_IN',
        statement_value: 'https://www.linkedin.com/username',
        statement_comment: 'a comment'
      };

      it('validation fails without https:// beginning', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewLinkedInCicStatement,
              statement_value: 'www.linkedin.com/username'
            }
          });
        }, 'LinkedIn needs go start with https://www.linkedin.com/ or https://linked.in/');
      });

      it('validation fails if domain is neither www.linkedin.com nor www.linked.in', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewLinkedInCicStatement,
              statement_value: 'https://www.linkedn.com/username'
            }
          });
        }, 'LinkedIn needs go start with https://www.linkedin.com/ or https://linked.in/');
      });

      it('validation fails if there is nothing following www.linkedin.com', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewLinkedInCicStatement,
              statement_value: 'https://www.linkedin.com/'
            }
          });
        }, 'LinkedIn needs go start with https://www.linkedin.com/ or https://linked.in/');
      });

      it('validation passes with www.linkedin.com followed by something', async () => {
        await cicService.addCicStatement({
          profile: aProfile,
          statement: {
            ...aNewLinkedInCicStatement,
            statement_value: 'https://www.linkedin.com/username'
          }
        });
      });

      it('validation passes with www.linked.in followed by something', async () => {
        await cicService.addCicStatement({
          profile: aProfile,
          statement: {
            ...aNewLinkedInCicStatement,
            statement_value: 'https://www.linked.in/username'
          }
        });
      });

      it('validation passes without www. in front of domain', async () => {
        await cicService.addCicStatement({
          profile: aProfile,
          statement: {
            ...aNewLinkedInCicStatement,
            statement_value: 'https://linkedin.com/username'
          }
        });
      });
    });

    describe('statement type is INSTAGRAM', () => {
      const aNewInstagramCicStatement = {
        profile_id: aProfileId,
        statement_group: CicStatementGroup.SOCIAL_MEDIA_ACCOUNT,
        statement_type: 'INSTAGRAM',
        statement_value: 'https://www.instagram.com/username',
        statement_comment: 'a comment'
      };

      it('validation fails without https:// beginning', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewInstagramCicStatement,
              statement_value: 'www.instagram.com/username'
            }
          });
        }, 'Instagram needs go start with https://www.instagram.com/');
      });

      it('validation fails if domain is not www.instagram.com', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewInstagramCicStatement,
              statement_value: 'https://www.instagam.com/username'
            }
          });
        }, 'Instagram needs go start with https://www.instagram.com/');
      });

      it('validation fails if there is nothing following www.facebook.com', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewInstagramCicStatement,
              statement_value: 'https://www.instagram.com/'
            }
          });
        }, 'Instagram needs go start with https://www.instagram.com/');
      });

      it('validation passes with www.facebook.com followed by something', async () => {
        await cicService.addCicStatement({
          profile: aProfile,
          statement: {
            ...aNewInstagramCicStatement,
            statement_value: 'https://www.instagram.com/username'
          }
        });
      });

      it('validation passes without www. in front of domain', async () => {
        await cicService.addCicStatement({
          profile: aProfile,
          statement: {
            ...aNewInstagramCicStatement,
            statement_value: 'https://instagram.com/username'
          }
        });
      });
    });

    describe('statement type is TIK_TOK', () => {
      const aNewTikTokCicStatement = {
        profile_id: aProfileId,
        statement_group: CicStatementGroup.SOCIAL_MEDIA_ACCOUNT,
        statement_type: 'TIK_TOK',
        statement_value: 'https://www.tiktok.com/@username',
        statement_comment: 'a comment'
      };

      it('validation fails without https:// beginning', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewTikTokCicStatement,
              statement_value: 'www.tiktok.com/@username'
            }
          });
        }, 'TikTok needs go start with https://www.tiktok.com/@');
      });

      it('validation fails if domain is not www.tiktok.com', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewTikTokCicStatement,
              statement_value: 'https://www.tiktoc.com/@username'
            }
          });
        }, 'TikTok needs go start with https://www.tiktok.com/@');
      });

      it('validation fails if there is nothing following www.tiktok.com/@', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewTikTokCicStatement,
              statement_value: 'https://www.tiktok.com/@'
            }
          });
        }, 'TikTok needs go start with https://www.tiktok.com/@');
      });

      it('validation fails if handle doesnt start with @', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewTikTokCicStatement,
              statement_value: 'https://www.tiktok.com/username'
            }
          });
        }, 'TikTok needs go start with https://www.tiktok.com/@');
      });

      it('validation passes with www.tiktok.com/@ followed by something', async () => {
        await cicService.addCicStatement({
          profile: aProfile,
          statement: {
            ...aNewTikTokCicStatement,
            statement_value: 'https://www.tiktok.com/@username'
          }
        });
      });

      it('validation passes without www. in front of domain', async () => {
        await cicService.addCicStatement({
          profile: aProfile,
          statement: {
            ...aNewTikTokCicStatement,
            statement_value: 'https://tiktok.com/@username'
          }
        });
      });
    });

    describe('statement type is GITHUB', () => {
      const aNewGitHubCicStatement = {
        profile_id: aProfileId,
        statement_group: CicStatementGroup.SOCIAL_MEDIA_ACCOUNT,
        statement_type: 'GITHUB',
        statement_value: 'https://www.github.com/username',
        statement_comment: 'a comment'
      };

      it('validation fails without https:// beginning', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewGitHubCicStatement,
              statement_value: 'www.github.com/username'
            }
          });
        }, 'GitHub needs go start with https://www.github.com/');
      });

      it('validation fails if domain is not www.github.com', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewGitHubCicStatement,
              statement_value: 'https://www.githup.com/username'
            }
          });
        }, 'GitHub needs go start with https://www.github.com/');
      });

      it('validation fails if there is nothing following www.github.com', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewGitHubCicStatement,
              statement_value: 'https://www.github.com/'
            }
          });
        }, 'GitHub needs go start with https://www.github.com/');
      });

      it('validation passes with www.github.com followed by something', async () => {
        await cicService.addCicStatement({
          profile: aProfile,
          statement: {
            ...aNewGitHubCicStatement,
            statement_value: 'https://www.github.com/username'
          }
        });
      });

      it('validation passes without www. in front of domain', async () => {
        await cicService.addCicStatement({
          profile: aProfile,
          statement: {
            ...aNewGitHubCicStatement,
            statement_value: 'https://github.com/username'
          }
        });
      });
    });

    describe('statement type is REDDIT', () => {
      const aNewRedditCicStatement = {
        profile_id: aProfileId,
        statement_group: CicStatementGroup.SOCIAL_MEDIA_ACCOUNT,
        statement_type: 'REDDIT',
        statement_value: 'https://www.reddit.com/u/username',
        statement_comment: 'a comment'
      };

      it('validation fails without https:// beginning', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewRedditCicStatement,
              statement_value: 'www.reddit.com/u/username'
            }
          });
        }, 'Reddit needs go start with https://www.reddit.com/ followed by /r/ or /u/ and subreddit or username');
      });

      it('validation fails if domain is not www.reddit.com', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewRedditCicStatement,
              statement_value: 'www.beddit.com/u/username'
            }
          });
        }, 'Reddit needs go start with https://www.reddit.com/ followed by /r/ or /u/ and subreddit or username');
      });

      it('validation fails if there is nothing following www.reddit.com/u/', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewRedditCicStatement,
              statement_value: 'https://www.reddit.com/u/'
            }
          });
        }, 'Reddit needs go start with https://www.reddit.com/ followed by /r/ or /u/ and subreddit or username');
      });

      it('validation fails if there is something else instead of /u/ or /r/ in the middle of URL', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewRedditCicStatement,
              statement_value: 'https://www.reddit.com/x/username'
            }
          });
        }, 'Reddit needs go start with https://www.reddit.com/ followed by /r/ or /u/ and subreddit or username');
      });

      it('validation fails if there is neither /u/ nor /r/ in the middle of URL', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewRedditCicStatement,
              statement_value: 'https://www.reddit.com/username'
            }
          });
        }, 'Reddit needs go start with https://www.reddit.com/ followed by /r/ or /u/ and subreddit or username');
      });

      it('validation passes with www.reddit.com/u/ followed by something', async () => {
        await cicService.addCicStatement({
          profile: aProfile,
          statement: {
            ...aNewRedditCicStatement,
            statement_value: 'https://www.reddit.com/u/username'
          }
        });
      });

      it('validation passes with www.reddit.com/r/ followed by something', async () => {
        await cicService.addCicStatement({
          profile: aProfile,
          statement: {
            ...aNewRedditCicStatement,
            statement_value: 'https://www.reddit.com/r/username'
          }
        });
      });

      it('validation passes without www. in front of domain', async () => {
        await cicService.addCicStatement({
          profile: aProfile,
          statement: {
            ...aNewRedditCicStatement,
            statement_value: 'https://reddit.com/u/username'
          }
        });
      });
    });

    describe('statement type is WEIBO', () => {
      const aNewWeiboCicStatement = {
        profile_id: aProfileId,
        statement_group: CicStatementGroup.SOCIAL_MEDIA_ACCOUNT,
        statement_type: 'WEIBO',
        statement_value: 'https://www.weibo.com/username',
        statement_comment: 'a comment'
      };

      it('validation fails without https:// beginning', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewWeiboCicStatement,
              statement_value: 'www.weibo.com/username'
            }
          });
        }, 'Weibo needs go start with https://www.weibo.com/');
      });

      it('validation fails if domain is not www.weibo.com', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewWeiboCicStatement,
              statement_value: 'www.welbo.com/username'
            }
          });
        }, 'Weibo needs go start with https://www.weibo.com/');
      });

      it('validation fails if there is nothing following www.weibo.com/', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewWeiboCicStatement,
              statement_value: 'https://www.weibo.com/'
            }
          });
        }, 'Weibo needs go start with https://www.weibo.com/');
      });

      it('validation passes with www.weibo.com/ followed by something', async () => {
        await cicService.addCicStatement({
          profile: aProfile,
          statement: {
            ...aNewWeiboCicStatement,
            statement_value: 'https://www.weibo.com/username'
          }
        });
      });

      it('validation passes without www. in front of domain', async () => {
        await cicService.addCicStatement({
          profile: aProfile,
          statement: {
            ...aNewWeiboCicStatement,
            statement_value: 'https://weibo.com/username'
          }
        });
      });
    });

    describe('statement type is SUBSTACK', () => {
      const aNewSubstackCicStatement = {
        profile_id: aProfileId,
        statement_group: CicStatementGroup.SOCIAL_MEDIA_ACCOUNT,
        statement_type: 'SUBSTACK',
        statement_value: 'https://username.substack.com/',
        statement_comment: 'a comment'
      };

      it('validation fails without https:// beginning', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewSubstackCicStatement,
              statement_value: 'username.substack.com/username'
            }
          });
        }, 'Substack needs to be https://yourusername.substack.com/');
      });

      it('validation fails if domain is not username.substack.com', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewSubstackCicStatement,
              statement_value: 'https://yourusername.subztack.com/'
            }
          });
        }, 'Substack needs to be https://yourusername.substack.com/');
      });

      it('validation fails if there is something following username.substack.com/', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewSubstackCicStatement,
              statement_value: 'https://username.substack.com/hello'
            }
          });
        }, 'Substack needs to be https://yourusername.substack.com/');
      });

      it('validation fails if there is no username subdomain', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewSubstackCicStatement,
              statement_value: 'https://substack.com/hello'
            }
          });
        }, 'Substack needs to be https://yourusername.substack.com/');
      });

      it('validation fails if there is a dot but no username subdomain', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewSubstackCicStatement,
              statement_value: 'https://.substack.com/hello'
            }
          });
        }, 'Substack needs to be https://yourusername.substack.com/');
      });

      it('validation passes with username.substack.com/', async () => {
        await cicService.addCicStatement({
          profile: aProfile,
          statement: {
            ...aNewSubstackCicStatement,
            statement_value: 'https://username.substack.com/'
          }
        });
      });

      it('validation passes with username.substack.com', async () => {
        await cicService.addCicStatement({
          profile: aProfile,
          statement: {
            ...aNewSubstackCicStatement,
            statement_value: 'https://username.substack.com'
          }
        });
      });
    });

    describe('statement type is MEDIUM', () => {
      const aNewMediumCicStatement = {
        profile_id: aProfileId,
        statement_group: CicStatementGroup.SOCIAL_MEDIA_ACCOUNT,
        statement_type: 'MEDIUM',
        statement_value: 'https://www.medium.com/@username',
        statement_comment: 'a comment'
      };

      it('validation fails without https:// beginning', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewMediumCicStatement,
              statement_value: 'www.medium.com/@username'
            }
          });
        }, 'Medium needs to start with https://www.medium.com/@');
      });

      it('validation fails if domain is not www.medium.com', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewMediumCicStatement,
              statement_value: 'https://www.mediun.com/@username'
            }
          });
        }, 'Medium needs to start with https://www.medium.com/@');
      });

      it('validation fails if there is nothing following www.medium.com/@', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewMediumCicStatement,
              statement_value: 'https://www.medium.com/@'
            }
          });
        }, 'Medium needs to start with https://www.medium.com/@');
      });

      it('validation fails if handle doesnt start with @', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewMediumCicStatement,
              statement_value: 'https://www.medium.com/username'
            }
          });
        }, 'Medium needs to start with https://www.medium.com/@');
      });

      it('validation passes with www.medium.com/@ followed by something', async () => {
        await cicService.addCicStatement({
          profile: aProfile,
          statement: {
            ...aNewMediumCicStatement,
            statement_value: 'https://www.medium.com/@username'
          }
        });
      });

      it('validation passes without www. in front of domain', async () => {
        await cicService.addCicStatement({
          profile: aProfile,
          statement: {
            ...aNewMediumCicStatement,
            statement_value: 'https://medium.com/@username'
          }
        });
      });
    });

    describe('statement type is MIRROR_XYZ', () => {
      const aNewMirrorXyzCicStatement = {
        profile_id: aProfileId,
        statement_group: CicStatementGroup.SOCIAL_MEDIA_ACCOUNT,
        statement_type: 'MIRROR_XYZ',
        statement_value: 'https://www.mirror.xyz/username',
        statement_comment: 'a comment'
      };

      it('validation fails without https:// beginning', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewMirrorXyzCicStatement,
              statement_value: 'www.mirror.xyz/username'
            }
          });
        }, 'Mirror needs to start with https://www.mirror.xyz/');
      });

      it('validation fails if domain is not www.mirror.xyz', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewMirrorXyzCicStatement,
              statement_value: 'https://www.mirror.xy/username'
            }
          });
        }, 'Mirror needs to start with https://www.mirror.xyz/');
      });

      it('validation fails if there is nothing following www.mirror.xyz/', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewMirrorXyzCicStatement,
              statement_value: 'https://www.mirror.xyz/'
            }
          });
        }, 'Mirror needs to start with https://www.mirror.xyz/');
      });

      it('validation passes with www.mirror.xyz/ followed by something', async () => {
        await cicService.addCicStatement({
          profile: aProfile,
          statement: {
            ...aNewMirrorXyzCicStatement,
            statement_value: 'https://www.mirror.xyz/username'
          }
        });
      });

      it('validation passes without www. in front of domain', async () => {
        await cicService.addCicStatement({
          profile: aProfile,
          statement: {
            ...aNewMirrorXyzCicStatement,
            statement_value: 'https://mirror.xyz/username'
          }
        });
      });
    });

    describe('statement type is YOUTUBE', () => {
      const aNewYoutubeCicStatement = {
        profile_id: aProfileId,
        statement_group: CicStatementGroup.SOCIAL_MEDIA_ACCOUNT,
        statement_type: 'YOUTUBE',
        statement_value: 'https://www.youtube.com/username',
        statement_comment: 'a comment'
      };

      it('validation fails without https:// beginning', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewYoutubeCicStatement,
              statement_value: 'www.youtube.com/username'
            }
          });
        }, 'Youtube needs to start with https://www.youtube.com/');
      });

      it('validation fails if domain is not www.youtube.com', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewYoutubeCicStatement,
              statement_value: 'https://www.you.tube/username'
            }
          });
        }, 'Youtube needs to start with https://www.youtube.com/');
      });

      it('validation fails if there is nothing following www.youtube.com/', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewYoutubeCicStatement,
              statement_value: 'https://www.youtube.com/'
            }
          });
        }, 'Youtube needs to start with https://www.youtube.com/');
      });

      it('validation passes with www.youtube.com/ followed by something', async () => {
        await cicService.addCicStatement({
          profile: aProfile,
          statement: {
            ...aNewYoutubeCicStatement,
            statement_value: 'https://www.youtube.com/username'
          }
        });
      });

      it('validation passes without www. in front of domain', async () => {
        await cicService.addCicStatement({
          profile: aProfile,
          statement: {
            ...aNewYoutubeCicStatement,
            statement_value: 'https://youtube.com/username'
          }
        });
      });
    });

    describe('statement type is DISCORD', () => {
      const aNewDiscordCicStatement = {
        profile_id: aProfileId,
        statement_group: CicStatementGroup.SOCIAL_MEDIA_ACCOUNT,
        statement_type: 'DISCORD',
        statement_value: 'a_discord_username',
        statement_comment: 'a comment'
      };

      it('validation fails if username is empty', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewDiscordCicStatement,
              statement_value: ''
            }
          });
        }, 'Discord needs to be less than 50 characters');
      });

      it('validation fails if username is longer than 50 characters', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewDiscordCicStatement,
              statement_value: 'r'.repeat(51)
            }
          });
        }, 'Discord needs to be less than 50 characters');
      });

      it('validation passes', async () => {
        await cicService.addCicStatement({
          profile: aProfile,
          statement: {
            ...aNewDiscordCicStatement,
            statement_value: 'r'.repeat(50)
          }
        });
      });
    });

    describe('statement type is TELEGRAM', () => {
      const aNewTelegramCicStatement = {
        profile_id: aProfileId,
        statement_group: CicStatementGroup.SOCIAL_MEDIA_ACCOUNT,
        statement_type: 'TELEGRAM',
        statement_value: 'a_telegram_username',
        statement_comment: 'a comment'
      };

      it('validation fails if username is empty', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewTelegramCicStatement,
              statement_value: ''
            }
          });
        }, 'Telegram needs to be less than 100 characters');
      });

      it('validation fails if username is longer than 100 characters', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewTelegramCicStatement,
              statement_value: 'r'.repeat(101)
            }
          });
        }, 'Telegram needs to be less than 100 characters');
      });

      it('validation passes', async () => {
        await cicService.addCicStatement({
          profile: aProfile,
          statement: {
            ...aNewTelegramCicStatement,
            statement_value: 'r'.repeat(100)
          }
        });
      });
    });

    describe('statement type is WECHAT', () => {
      const aNewWeChatCicStatement = {
        profile_id: aProfileId,
        statement_group: CicStatementGroup.SOCIAL_MEDIA_ACCOUNT,
        statement_type: 'WECHAT',
        statement_value: 'a_wechat_username',
        statement_comment: 'a comment'
      };

      it('validation fails if username is empty', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewWeChatCicStatement,
              statement_value: ''
            }
          });
        }, 'WeChat needs to be less than 100 characters');
      });

      it('validation fails if username is longer than 100 characters', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewWeChatCicStatement,
              statement_value: 'r'.repeat(101)
            }
          });
        }, 'WeChat needs to be less than 100 characters');
      });

      it('validation passes', async () => {
        await cicService.addCicStatement({
          profile: aProfile,
          statement: {
            ...aNewWeChatCicStatement,
            statement_value: 'r'.repeat(100)
          }
        });
      });
    });

    describe('statement type is EMAIL', () => {
      const aNewEmailCicStatement = {
        profile_id: aProfileId,
        statement_group: CicStatementGroup.SOCIAL_MEDIA_ACCOUNT,
        statement_type: 'EMAIL',
        statement_value: 'an_email',
        statement_comment: 'a comment'
      };

      it('validation fails if email is faulty', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewEmailCicStatement,
              statement_value: 'njefmkds'
            }
          });
        }, 'Email is not valid');
      });

      it('validation passes', async () => {
        await cicService.addCicStatement({
          profile: aProfile,
          statement: {
            ...aNewEmailCicStatement,
            statement_value: 'test@example.com'
          }
        });
      });
    });

    describe('statement type is WEBSITE', () => {
      const aNewWebsiteCicStatement = {
        profile_id: aProfileId,
        statement_group: CicStatementGroup.SOCIAL_MEDIA_ACCOUNT,
        statement_type: 'WEBSITE',
        statement_value: 'https://www.example.com',
        statement_comment: 'a comment'
      };

      it('validation fails if no protocol', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewWebsiteCicStatement,
              statement_value: 'www.example.com'
            }
          });
        }, "Website needs to start with http or https and URL can't be longer than 2000 characters");
      });

      it('validation fails if unknown protocol', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewWebsiteCicStatement,
              statement_value: 'ftp://www.example.com'
            }
          });
        }, "Website needs to start with http or https and URL can't be longer than 2000 characters");
      });

      it('validation fails if nothing follows the protocol', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewWebsiteCicStatement,
              statement_value: 'https://'
            }
          });
        }, "Website needs to start with http or https and URL can't be longer than 2000 characters");
      });

      it('validation passes with http', async () => {
        await cicService.addCicStatement({
          profile: aProfile,
          statement: {
            ...aNewWebsiteCicStatement,
            statement_value: 'http://www.example.com'
          }
        });
      });

      it('validation passes with https', async () => {
        await cicService.addCicStatement({
          profile: aProfile,
          statement: {
            ...aNewWebsiteCicStatement,
            statement_value: 'https://www.example.com'
          }
        });
      });
    });

    describe('statement type is LINK', () => {
      const aNewWebsiteCicStatement = {
        profile_id: aProfileId,
        statement_group: CicStatementGroup.SOCIAL_MEDIA_ACCOUNT,
        statement_type: 'LINK',
        statement_value: 'https://www.example.com',
        statement_comment: 'a comment'
      };

      it('validation fails if no protocol', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewWebsiteCicStatement,
              statement_value: 'www.example.com'
            }
          });
        }, "Link needs to start with http or https and URL can't be longer than 2000 characters");
      });

      it('validation fails if unknown protocol', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewWebsiteCicStatement,
              statement_value: 'ftp://www.example.com'
            }
          });
        }, "Link needs to start with http or https and URL can't be longer than 2000 characters");
      });

      it('validation fails if nothing follows the protocol', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewWebsiteCicStatement,
              statement_value: 'https://'
            }
          });
        }, "Link needs to start with http or https and URL can't be longer than 2000 characters");
      });

      it('validation passes with http', async () => {
        await cicService.addCicStatement({
          profile: aProfile,
          statement: {
            ...aNewWebsiteCicStatement,
            statement_value: 'http://www.example.com'
          }
        });
      });

      it('validation passes with https', async () => {
        await cicService.addCicStatement({
          profile: aProfile,
          statement: {
            ...aNewWebsiteCicStatement,
            statement_value: 'https://www.example.com'
          }
        });
      });
    });

    describe('statement type is SUPER_RARE', () => {
      const aNewCicStatement = {
        profile_id: aProfileId,
        statement_group: CicStatementGroup.NFT_ACCOUNTS,
        statement_type: 'SUPER_RARE',
        statement_value: 'https://www.superrare.com/username',
        statement_comment: 'a comment'
      };

      it('validation fails without https:// beginning', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewCicStatement,
              statement_value: 'www.superrare.com/username'
            }
          });
        }, 'SuperRare needs to start with https://www.superrare.com/');
      });

      it('validation fails if domain is not www.superrare.com', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewCicStatement,
              statement_value: 'https://www.super.rare/username'
            }
          });
        }, 'SuperRare needs to start with https://www.superrare.com/');
      });

      it('validation fails if there is nothing following www.superrare.com/', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewCicStatement,
              statement_value: 'https://www.superrare.com/'
            }
          });
        }, 'SuperRare needs to start with https://www.superrare.com/');
      });

      it('validation passes with www.superrare.com/ followed by something', async () => {
        await cicService.addCicStatement({
          profile: aProfile,
          statement: {
            ...aNewCicStatement,
            statement_value: 'https://www.superrare.com/username'
          }
        });
      });

      it('validation passes without www. in front of domain', async () => {
        await cicService.addCicStatement({
          profile: aProfile,
          statement: {
            ...aNewCicStatement,
            statement_value: 'https://superrare.com/username'
          }
        });
      });
    });

    describe('statement type is FOUNDATION', () => {
      const aNewCicStatement = {
        profile_id: aProfileId,
        statement_group: CicStatementGroup.NFT_ACCOUNTS,
        statement_type: 'FOUNDATION',
        statement_value: 'https://www.foundation.app/username',
        statement_comment: 'a comment'
      };

      it('validation fails without https:// beginning', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewCicStatement,
              statement_value: 'www.foundation.app/username'
            }
          });
        }, 'Foundation needs to start with https://www.foundation.app/');
      });

      it('validation fails if domain is not www.foundation.app', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewCicStatement,
              statement_value: 'https://www.found.ation.app/username'
            }
          });
        }, 'Foundation needs to start with https://www.foundation.app/');
      });

      it('validation fails if there is nothing following www.foundation.app/', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewCicStatement,
              statement_value: 'https://www.foundation.app/'
            }
          });
        }, 'Foundation needs to start with https://www.foundation.app/');
      });

      it('validation passes with www.foundation.app/ followed by something', async () => {
        await cicService.addCicStatement({
          profile: aProfile,
          statement: {
            ...aNewCicStatement,
            statement_value: 'https://www.foundation.app/username'
          }
        });
      });

      it('validation passes without www. in front of domain', async () => {
        await cicService.addCicStatement({
          profile: aProfile,
          statement: {
            ...aNewCicStatement,
            statement_value: 'https://foundation.app/username'
          }
        });
      });
    });

    describe('statement type is MAKERS_PLACE', () => {
      const aNewCicStatement = {
        profile_id: aProfileId,
        statement_group: CicStatementGroup.NFT_ACCOUNTS,
        statement_type: 'MAKERS_PLACE',
        statement_value: 'https://www.makersplace.com/username',
        statement_comment: 'a comment'
      };

      it('validation fails without https:// beginning', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewCicStatement,
              statement_value: 'www.makersplace.com/username'
            }
          });
        }, 'MakersPlace needs to start with https://www.makersplace.com/');
      });

      it('validation fails if domain is not www.makersplace.com', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewCicStatement,
              statement_value: 'https://www.makers.place.com/username'
            }
          });
        }, 'MakersPlace needs to start with https://www.makersplace.com/');
      });

      it('validation fails if there is nothing following www.makersplace.com/', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewCicStatement,
              statement_value: 'https://www.makersplace.com/'
            }
          });
        }, 'MakersPlace needs to start with https://www.makersplace.com/');
      });

      it('validation passes with www.makersplace.com/ followed by something', async () => {
        await cicService.addCicStatement({
          profile: aProfile,
          statement: {
            ...aNewCicStatement,
            statement_value: 'https://www.makersplace.com/username'
          }
        });
      });

      it('validation passes without www. in front of domain', async () => {
        await cicService.addCicStatement({
          profile: aProfile,
          statement: {
            ...aNewCicStatement,
            statement_value: 'https://makersplace.com/username'
          }
        });
      });
    });

    describe('statement type is KNOWN_ORIGIN', () => {
      const aNewCicStatement = {
        profile_id: aProfileId,
        statement_group: CicStatementGroup.NFT_ACCOUNTS,
        statement_type: 'KNOWN_ORIGIN',
        statement_value: 'https://www.knownorigin.io/username',
        statement_comment: 'a comment'
      };

      it('validation fails without https:// beginning', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewCicStatement,
              statement_value: 'www.knownorigin.io/username'
            }
          });
        }, 'KnownOrigin needs to start with https://www.knownorigin.io/');
      });

      it('validation fails if domain is not www.knownorigin.io', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewCicStatement,
              statement_value: 'https://www.known.origin.io/username'
            }
          });
        }, 'KnownOrigin needs to start with https://www.knownorigin.io/');
      });

      it('validation fails if there is nothing following www.knownorigin.io/', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewCicStatement,
              statement_value: 'https://www.knownorigin.io/'
            }
          });
        }, 'KnownOrigin needs to start with https://www.knownorigin.io/');
      });

      it('validation passes with www.knownorigin.io/ followed by something', async () => {
        await cicService.addCicStatement({
          profile: aProfile,
          statement: {
            ...aNewCicStatement,
            statement_value: 'https://www.knownorigin.io/username'
          }
        });
      });

      it('validation passes without www. in front of domain', async () => {
        await cicService.addCicStatement({
          profile: aProfile,
          statement: {
            ...aNewCicStatement,
            statement_value: 'https://knownorigin.io/username'
          }
        });
      });
    });

    describe('statement type is PEPE_WTF', () => {
      const aNewCicStatement = {
        profile_id: aProfileId,
        statement_group: CicStatementGroup.NFT_ACCOUNTS,
        statement_type: 'PEPE_WTF',
        statement_value: 'https://www.pepe.wtf/username',
        statement_comment: 'a comment'
      };

      it('validation fails without https:// beginning', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewCicStatement,
              statement_value: 'www.pepe.wtf/username'
            }
          });
        }, 'Pepe.wtf needs to start with https://www.pepe.wtf/');
      });

      it('validation fails if domain is not www.pepe.wtf', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewCicStatement,
              statement_value: 'https://www.pepe.wtf.com/username'
            }
          });
        }, 'Pepe.wtf needs to start with https://www.pepe.wtf/');
      });

      it('validation fails if there is nothing following www.pepe.wtf/', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewCicStatement,
              statement_value: 'https://www.pepe.wtf/'
            }
          });
        }, 'Pepe.wtf needs to start with https://www.pepe.wtf/');
      });

      it('validation passes with www.pepe.wtf/ followed by something', async () => {
        await cicService.addCicStatement({
          profile: aProfile,
          statement: {
            ...aNewCicStatement,
            statement_value: 'https://www.pepe.wtf/username'
          }
        });
      });

      it('validation passes without www. in front of domain', async () => {
        await cicService.addCicStatement({
          profile: aProfile,
          statement: {
            ...aNewCicStatement,
            statement_value: 'https://pepe.wtf/username'
          }
        });
      });
    });

    describe('statement type is OPENSEA', () => {
      const aNewCicStatement = {
        profile_id: aProfileId,
        statement_group: CicStatementGroup.NFT_ACCOUNTS,
        statement_type: 'OPENSEA',
        statement_value: 'https://www.opensea.io/username',
        statement_comment: 'a comment'
      };

      it('validation fails without https:// beginning', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewCicStatement,
              statement_value: 'www.opensea.io/username'
            }
          });
        }, 'OpenSea needs to start with https://www.opensea.io/');
      });

      it('validation fails if domain is not www.pepe.wtf', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewCicStatement,
              statement_value: 'https://www.open.sea.io/username'
            }
          });
        }, 'OpenSea needs to start with https://www.opensea.io/');
      });

      it('validation fails if there is nothing following www.opensea.io/', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewCicStatement,
              statement_value: 'https://www.opensea.io/'
            }
          });
        }, 'OpenSea needs to start with https://www.opensea.io/');
      });

      it('validation passes with www.opensea.io/ followed by something', async () => {
        await cicService.addCicStatement({
          profile: aProfile,
          statement: {
            ...aNewCicStatement,
            statement_value: 'https://www.opensea.io/username'
          }
        });
      });

      it('validation passes without www. in front of domain', async () => {
        await cicService.addCicStatement({
          profile: aProfile,
          statement: {
            ...aNewCicStatement,
            statement_value: 'https://opensea.io/username'
          }
        });
      });
    });

    describe('statement type is ART_BLOCKS', () => {
      const aNewCicStatement = {
        profile_id: aProfileId,
        statement_group: CicStatementGroup.NFT_ACCOUNTS,
        statement_type: 'ART_BLOCKS',
        statement_value: 'https://www.artblocks.io/username',
        statement_comment: 'a comment'
      };

      it('validation fails without https:// beginning', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewCicStatement,
              statement_value: 'www.artblocks.io/username'
            }
          });
        }, 'Art Blocks needs to start with https://www.artblocks.io/');
      });

      it('validation fails if domain is not www.artblocks.io', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewCicStatement,
              statement_value: 'https://www.art.blocks.io/username'
            }
          });
        }, 'Art Blocks needs to start with https://www.artblocks.io/');
      });

      it('validation fails if there is nothing following www.artblocks.io/', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewCicStatement,
              statement_value: 'https://www.artblocks.io/'
            }
          });
        }, 'Art Blocks needs to start with https://www.artblocks.io/');
      });

      it('validation passes with www.artblocks.io/ followed by something', async () => {
        await cicService.addCicStatement({
          profile: aProfile,
          statement: {
            ...aNewCicStatement,
            statement_value: 'https://www.artblocks.io/username'
          }
        });
      });

      it('validation passes without www. in front of domain', async () => {
        await cicService.addCicStatement({
          profile: aProfile,
          statement: {
            ...aNewCicStatement,
            statement_value: 'https://artblocks.io/username'
          }
        });
      });
    });

    describe('statement type is DECA_ART', () => {
      const aNewCicStatement = {
        profile_id: aProfileId,
        statement_group: CicStatementGroup.NFT_ACCOUNTS,
        statement_type: 'DECA_ART',
        statement_value: 'https://www.deca.art/username',
        statement_comment: 'a comment'
      };

      it('validation fails without https:// beginning', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewCicStatement,
              statement_value: 'www.deca.art/username'
            }
          });
        }, 'Deca Art needs to start with https://www.deca.art/');
      });

      it('validation fails if domain is not www.pepe.wtf', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewCicStatement,
              statement_value: 'https://www.dec.a.art/username'
            }
          });
        }, 'Deca Art needs to start with https://www.deca.art/');
      });

      it('validation fails if there is nothing following www.deca.art/', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewCicStatement,
              statement_value: 'https://www.deca.art/'
            }
          });
        }, 'Deca Art needs to start with https://www.deca.art/');
      });

      it('validation passes with www.deca.art/ followed by something', async () => {
        await cicService.addCicStatement({
          profile: aProfile,
          statement: {
            ...aNewCicStatement,
            statement_value: 'https://www.deca.art/username'
          }
        });
      });

      it('validation passes without www. in front of domain', async () => {
        await cicService.addCicStatement({
          profile: aProfile,
          statement: {
            ...aNewCicStatement,
            statement_value: 'https://deca.art/username'
          }
        });
      });
    });

    describe('statement type is ON_CYBER', () => {
      const aNewCicStatement = {
        profile_id: aProfileId,
        statement_group: CicStatementGroup.NFT_ACCOUNTS,
        statement_type: 'ON_CYBER',
        statement_value: 'https://www.oncyber.io/username',
        statement_comment: 'a comment'
      };

      it('validation fails without https:// beginning', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewCicStatement,
              statement_value: 'www.oncyber.io/username'
            }
          });
        }, 'OnCyber needs to start with https://www.oncyber.io/');
      });

      it('validation fails if domain is not www.oncyber.io', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewCicStatement,
              statement_value: 'https://www.on.cyber.io/username'
            }
          });
        }, 'OnCyber needs to start with https://www.oncyber.io/');
      });

      it('validation fails if there is nothing following www.oncyber.io/', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewCicStatement,
              statement_value: 'https://www.oncyber.io/'
            }
          });
        }, 'OnCyber needs to start with https://www.oncyber.io/');
      });

      it('validation passes with www.oncyber.io/ followed by something', async () => {
        await cicService.addCicStatement({
          profile: aProfile,
          statement: {
            ...aNewCicStatement,
            statement_value: 'https://www.oncyber.io/username'
          }
        });
      });

      it('validation passes without www. in front of domain', async () => {
        await cicService.addCicStatement({
          profile: aProfile,
          statement: {
            ...aNewCicStatement,
            statement_value: 'https://oncyber.io/username'
          }
        });
      });
    });

    describe('statement type is THE_LINE', () => {
      const aNewCicStatement = {
        profile_id: aProfileId,
        statement_group: CicStatementGroup.NFT_ACCOUNTS,
        statement_type: 'THE_LINE',
        statement_value: 'https://www.oncyber.io/line1',
        statement_comment: 'a comment'
      };

      it('validation fails without https:// beginning', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewCicStatement,
              statement_value: 'www.oncyber.io/line1'
            }
          });
        }, 'The Line needs to start with https://www.oncyber.io/line');
      });

      it('validation fails if domain is not www.oncyber.io/line', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewCicStatement,
              statement_value: 'https://www.oncyber.io/username'
            }
          });
        }, 'The Line needs to start with https://www.oncyber.io/line');
      });

      it('validation fails if there is nothing following www.oncyber.io/line', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewCicStatement,
              statement_value: 'https://www.oncyber.io/line'
            }
          });
        }, 'The Line needs to start with https://www.oncyber.io/line');
      });

      it('validation passes with www.oncyber.io/line followed by something', async () => {
        await cicService.addCicStatement({
          profile: aProfile,
          statement: {
            ...aNewCicStatement,
            statement_value: 'https://www.oncyber.io/line2'
          }
        });
      });

      it('validation passes without www. in front of domain', async () => {
        await cicService.addCicStatement({
          profile: aProfile,
          statement: {
            ...aNewCicStatement,
            statement_value: 'https://oncyber.io/line2'
          }
        });
      });
    });

    describe('statement type has not rule', () => {
      const aNewUnknownCicStatement = {
        profile_id: aProfileId,
        statement_group: CicStatementGroup.SOCIAL_MEDIA_ACCOUNT,
        statement_type: 'UNDEFINED',
        statement_value: 'some value',
        statement_comment: 'a comment'
      };
      it('validation fails if longer than 500 characters', async () => {
        await expectExceptionWithMessage(async () => {
          await cicService.addCicStatement({
            profile: aProfile,
            statement: {
              ...aNewUnknownCicStatement,
              statement_value: 'r'.repeat(501)
            }
          });
        }, 'Statement of type UNDEFINED can not be longer than 500 characters');
      });

      it('validation passes if in constraints', async () => {
        await cicService.addCicStatement({
          profile: aProfile,
          statement: {
            ...aNewUnknownCicStatement,
            statement_value: 'r'.repeat(500)
          }
        });
      });
    });

    it('statement adding fails if statement with same type and value already exists', async () => {
      const addCicStatement = {
        profile_id: aProfileId,
        statement_group: CicStatementGroup.SOCIAL_MEDIA_ACCOUNT,
        statement_type: 'LINK',
        statement_value: 'https://www.example.com',
        statement_comment: 'a comment'
      };
      when(cicDb.getCicStatementsByProfileId)
        .calledWith(aProfileId, mockConnection)
        .mockResolvedValue([
          {
            ...addCicStatement,
            id: uniqueShortId(),
            crated_at: new Date()
          }
        ]);
      await expectExceptionWithMessage(async () => {
        await cicService.addCicStatement({
          profile: aProfile,
          statement: addCicStatement
        });
      }, 'Statement of type LINK with value https://www.example.com already exists');
    });

    it('successful statement adding does the correct database updates', async () => {
      const addCicStatement = {
        profile_id: aProfileId,
        statement_group: CicStatementGroup.SOCIAL_MEDIA_ACCOUNT,
        statement_type: 'LINK',
        statement_value: 'https://www.example.com',
        statement_comment: 'a comment'
      };
      const cicStatement = await cicService.addCicStatement({
        profile: aProfile,
        statement: addCicStatement
      });
      expect(cicDb.insertCicStatement).toHaveBeenCalledWith(
        addCicStatement,
        mockConnection
      );
      expect(profileActivityLogsDb.insert).toHaveBeenCalledWith(
        {
          profile_id: aProfileId,
          target_id: null,
          type: ProfileActivityLogType.SOCIALS_EDIT,
          contents: JSON.stringify({ action: 'ADD', statement: cicStatement }),
          proxy_id: null,
          additional_data_1: null,
          additional_data_2: null
        },
        mockConnection
      );
    });
  });
});
