import { RatingsService } from './ratings.service';
import { mock, Mock } from 'ts-jest-mocker';
import { AggregatedRatingRequest, RatingsDb } from './ratings.db';
import { ProfilesDb } from '../profiles/profiles.db';
import { ProfileActivityLogsDb } from '../profileActivityLogs/profile-activity-logs.db';
import {
  expectExceptionWithMessage,
  mockConnection,
  mockDbService
} from '../tests/test.helper';
import { when } from 'jest-when';
import { RateMatter } from '../entities/IRating';
import { Time } from '../time';
import { ProfileActivityLogType } from '../entities/IProfileActivityLog';
import { RepService } from '../api-serverless/src/profiles/rep.service';
import { EventScheduler } from '../events/event.scheduler';
import { ArweaveFileUploader } from '../arweave';
import { ProfileProxiesDb } from '../profile-proxies/profile-proxies.db';
import { AuthenticationContext } from '../auth-context';
import * as fs from 'fs';

const authContext: AuthenticationContext = new AuthenticationContext({
  authenticatedProfileId: 'pid',
  authenticatedWallet: 'wallet',
  roleProfileId: null,
  activeProxyActions: []
});

describe('RatingsService', () => {
  let ratingsService: RatingsService;
  let ratingsDb: Mock<RatingsDb>;
  let profilesDb: Mock<ProfilesDb>;
  let repService: Mock<RepService>;
  let profileActivityLogsDb: Mock<ProfileActivityLogsDb>;
  let eventScheduler: Mock<EventScheduler>;
  let arweaveFileUploader: Mock<ArweaveFileUploader>;
  let profileProxiesDb: Mock<ProfileProxiesDb>;

  beforeEach(() => {
    profilesDb = mockDbService();
    ratingsDb = mockDbService();
    profileActivityLogsDb = mockDbService();
    eventScheduler = mock(EventScheduler);
    repService = mock(RepService);
    arweaveFileUploader = mock(ArweaveFileUploader);
    profileProxiesDb = mock(ProfileProxiesDb);
    ratingsService = new RatingsService(
      ratingsDb,
      profilesDb,
      repService,
      profileActivityLogsDb,
      eventScheduler,
      arweaveFileUploader,
      profileProxiesDb
    );
  });

  describe('getAggregatedRatingOnMatter', () => {
    it('should call ratingsDb.getAggregatedRatingOnMatter', async () => {
      const request: AggregatedRatingRequest = {
        matter: 'a_matter',
        rater_profile_id: 'a_profile_id',
        matter_category: 'a_matter_category',
        matter_target_id: 'a_matter_target_id'
      };
      when(ratingsDb.getAggregatedRatingOnMatter).mockResolvedValue({
        rating: 10,
        contributor_count: 2
      });
      const aggregatedRating = await ratingsService.getAggregatedRatingOnMatter(
        request
      );

      expect(aggregatedRating).toEqual({
        rating: 10,
        contributor_count: 2
      });
    });
  });

  describe('getRatesLeftOnMatterForProfile', () => {
    it('should call ratingsDb.searchRatingsForMatter and enhance results with levels', async () => {
      when(ratingsDb.getRatesSpentOnMatterByProfile).mockResolvedValue(8);
      when(profilesDb.getProfileTdh).mockResolvedValue(10);
      const result = await ratingsService.getRatesLeftOnMatterForProfile({
        profile_id: 'pid',
        matter: RateMatter.CIC
      });

      expect(result).toEqual(2);
    });
  });

  describe('updateRating', () => {
    it('not enough TDH', async () => {
      when(profilesDb.getProfileTdh).mockResolvedValue(10);
      when(ratingsDb.getRatingForUpdate).mockResolvedValue({
        rating: -6,
        rater_profile_id: 'pid',
        matter: RateMatter.CIC,
        matter_target_id: 'mid',
        matter_category: 'mcat',
        last_modified: Time.millis(0).toDate(),
        total_tdh_spent_on_matter: 8
      });
      await expectExceptionWithMessage(async () => {
        await ratingsService.updateRating({
          authenticationContext: authContext,
          rater_profile_id: 'pid',
          matter: RateMatter.CIC,
          matter_target_id: 'mid',
          matter_category: 'mcat',
          rating: 10
        });
      }, 'Not enough TDH left to spend on this matter. Changing this vote would spend 4 TDH, but profile only has 2 left to spend');
    });

    it('not able to rate themselves', async () => {
      await expectExceptionWithMessage(async () => {
        await ratingsService.updateRating({
          authenticationContext: authContext,
          rater_profile_id: 'pid',
          matter: RateMatter.CIC,
          matter_target_id: 'pid',
          matter_category: 'mcat',
          rating: 10
        });
      }, 'User can not rate their own profile');
    });

    it('enough TDH - correct db modifications are done', async () => {
      when(profilesDb.getProfileTdh).mockResolvedValue(12);
      when(ratingsDb.getRatingForUpdate).mockResolvedValue({
        rating: -6,
        rater_profile_id: 'pid',
        matter: RateMatter.CIC,
        matter_target_id: 'mid',
        matter_category: 'CIC',
        last_modified: Time.millis(0).toDate(),
        total_tdh_spent_on_matter: 8
      });
      const request = {
        authenticationContext: authContext,
        rater_profile_id: 'pid',
        matter: RateMatter.CIC,
        matter_target_id: 'mid',
        matter_category: 'CIC',
        rating: 10
      };
      await ratingsService.updateRating(request);
      expect(ratingsDb.updateRating).toHaveBeenCalledWith(
        request,
        mockConnection
      );
      expect(profileActivityLogsDb.insert).toHaveBeenCalledWith(
        {
          profile_id: 'pid',
          target_id: 'mid',
          type: ProfileActivityLogType.RATING_EDIT,
          contents: JSON.stringify({
            old_rating: -6,
            new_rating: 10,
            rating_matter: 'CIC',
            rating_category: 'CIC',
            change_reason: 'USER_EDIT'
          }),
          proxy_id: null
        },
        mockConnection
      );
    });

    it('enough TDH, but rating did not change - no db modifications are done', async () => {
      when(profilesDb.getProfileTdh).mockResolvedValue(12);
      when(ratingsDb.getRatingForUpdate).mockResolvedValue({
        rating: -6,
        rater_profile_id: 'pid',
        matter: RateMatter.CIC,
        matter_target_id: 'mid',
        matter_category: 'CIC',
        last_modified: Time.millis(0).toDate(),
        total_tdh_spent_on_matter: 8
      });
      const request = {
        authenticationContext: authContext,
        rater_profile_id: 'pid',
        matter: RateMatter.CIC,
        matter_target_id: 'mid',
        matter_category: 'CIC',
        rating: -6
      };
      await ratingsService.updateRating(request);
      expect(ratingsDb.updateRating).not.toHaveBeenCalledWith(
        request,
        mockConnection
      );
      expect(profileActivityLogsDb.insert).not.toHaveBeenCalledWith(
        {
          profile_id: 'pid',
          target_id: 'mid',
          type: ProfileActivityLogType.RATING_EDIT,
          contents: JSON.stringify({
            old_rating: -6,
            new_rating: -6,
            rating_matter: 'CIC',
            rating_category: 'CIC',
            change_reason: 'USER_EDIT'
          })
        },
        mockConnection
      );
    });
  });

  describe('revokeOverRates', () => {
    it('reduces all rates on matter when there TDH is overspent', async () => {
      when(ratingsDb.getSnapshotOfAllCicRatings).mockResolvedValue([]);
      when(ratingsDb.getSnapshotOfAllRepRatings).mockResolvedValue([]);
      when(arweaveFileUploader.uploadFile).mockResolvedValue({
        url: 'arweave_url'
      });
      when(ratingsDb.getOverRateMatters).mockResolvedValue([
        {
          rater_profile_id: 'pid',
          matter: RateMatter.CIC,
          tally: 20,
          rater_tdh: 8
        }
      ]);
      when(ratingsDb.lockRatingsOnMatterForUpdate).mockResolvedValue([
        {
          rating: 10,
          rater_profile_id: 'pid',
          matter: RateMatter.CIC,
          matter_target_id: 'mid2',
          matter_category: 'CIC',
          last_modified: Time.millis(0).toDate()
        },
        {
          rating: -10,
          rater_profile_id: 'pid',
          matter: RateMatter.CIC,
          matter_target_id: 'mid2',
          matter_category: 'CIC2',
          last_modified: Time.millis(0).toDate()
        }
      ]);
      await ratingsService.reduceOverRates();
      expect(ratingsDb.updateRating).toHaveBeenCalledWith(
        {
          rater_profile_id: 'pid',
          matter: RateMatter.CIC,
          matter_target_id: 'mid2',
          matter_category: 'CIC',
          last_modified: expect.any(Date),
          rating: 4
        },
        mockConnection
      );
      expect(ratingsDb.updateRating).toHaveBeenCalledWith(
        {
          rater_profile_id: 'pid',
          matter: RateMatter.CIC,
          matter_target_id: 'mid2',
          matter_category: 'CIC2',
          last_modified: expect.any(Date),
          rating: -4
        },
        mockConnection
      );
      expect(profileActivityLogsDb.insert).toHaveBeenCalledWith(
        {
          profile_id: 'pid',
          target_id: 'mid2',
          type: ProfileActivityLogType.RATING_EDIT,
          contents: JSON.stringify({
            old_rating: 10,
            new_rating: 4,
            rating_matter: 'CIC',
            rating_category: 'CIC',
            change_reason: 'LOST_TDH'
          }),
          proxy_id: null
        },
        mockConnection
      );
      expect(profileActivityLogsDb.insert).toHaveBeenCalledWith(
        {
          profile_id: 'pid',
          target_id: 'mid2',
          type: ProfileActivityLogType.RATING_EDIT,
          contents: JSON.stringify({
            old_rating: -10,
            new_rating: -4,
            rating_matter: 'CIC',
            rating_category: 'CIC2',
            change_reason: 'LOST_TDH'
          }),
          proxy_id: null
        },
        mockConnection
      );
      expect(ratingsDb.insertSnapshot).toHaveBeenCalledTimes(2);
    });

    it('reduces some rates on matter when there TDH is overspent', async () => {
      when(ratingsDb.getSnapshotOfAllCicRatings).mockResolvedValue([]);
      when(ratingsDb.getSnapshotOfAllRepRatings).mockResolvedValue([]);
      when(arweaveFileUploader.uploadFile).mockResolvedValue({
        url: 'arweave_url'
      });
      when(ratingsDb.getOverRateMatters).mockResolvedValue([
        {
          rater_profile_id: 'pid',
          matter: RateMatter.CIC,
          tally: 11,
          rater_tdh: 10
        }
      ]);
      when(ratingsDb.lockRatingsOnMatterForUpdate).mockResolvedValue([
        {
          rating: -6,
          rater_profile_id: 'pid',
          matter: RateMatter.CIC,
          matter_target_id: 'mid2',
          matter_category: 'CIC',
          last_modified: Time.millis(0).toDate()
        },
        {
          rating: -5,
          rater_profile_id: 'pid',
          matter: RateMatter.CIC,
          matter_target_id: 'mid2',
          matter_category: 'CIC2',
          last_modified: Time.millis(0).toDate()
        }
      ]);
      await ratingsService.reduceOverRates();
      expect(ratingsDb.updateRating).toHaveBeenCalledWith(
        {
          rater_profile_id: 'pid',
          matter: RateMatter.CIC,
          matter_target_id: 'mid2',
          matter_category: 'CIC',
          last_modified: expect.any(Date),
          rating: -5
        },
        mockConnection
      );
      expect(ratingsDb.updateRating).not.toHaveBeenCalledWith(
        {
          rater_profile_id: 'pid',
          matter: RateMatter.CIC,
          matter_target_id: 'mid2',
          matter_category: 'CIC2',
          last_modified: expect.any(Date),
          rating: expect.any(Number)
        },
        mockConnection
      );
      expect(profileActivityLogsDb.insert).toHaveBeenCalledWith(
        {
          profile_id: 'pid',
          target_id: 'mid2',
          type: ProfileActivityLogType.RATING_EDIT,
          contents: JSON.stringify({
            old_rating: -6,
            new_rating: -5,
            rating_matter: 'CIC',
            rating_category: 'CIC',
            change_reason: 'LOST_TDH'
          }),
          proxy_id: null
        },
        mockConnection
      );
      expect(profileActivityLogsDb.insert).not.toHaveBeenCalledWith(
        {
          profile_id: 'pid',
          target_id: 'mid2',
          type: ProfileActivityLogType.RATING_EDIT,
          contents: JSON.stringify({
            old_rating: -5,
            new_rating: -4,
            rating_matter: 'CIC',
            rating_category: 'CIC2',
            change_reason: 'LOST_TDH'
          })
        },
        mockConnection
      );
      expect(ratingsDb.insertSnapshot).toHaveBeenCalledTimes(2);
    });
  });

  it('wurks', async () => {
    const arr = [
      'a',
      'b',
      'c',
      'd',
      'e',
      'f',
      '0',
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9'
    ];
    const wallets = [];
    for (let z = 0; z < 100; z++) {
      let wallet = '0x';
      for (let i = 0; i < 40; i++) {
        const random = Math.floor(Math.random() * arr.length);
        let randomChar = arr[random];
        if (random < 6) {
          const r = Math.random();
          if (r > 0.5) {
            randomChar = randomChar.toUpperCase();
          }
        }
        wallet += randomChar;
      }
      wallets.push(wallet);
    }
    fs.writeFileSync('wallets.json', JSON.stringify({ wallets }));
  });
});
