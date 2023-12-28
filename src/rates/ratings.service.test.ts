import { RatingsService } from './ratings.service';
import { mock, Mock } from 'ts-jest-mocker';
import {
  AggregatedRatingRequest,
  RatingsDb,
  RatingsSearchRequest
} from './ratings.db';
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

describe('RatingsService', () => {
  let ratingsService: RatingsService;
  let ratingsDb: Mock<RatingsDb>;
  let profilesDb: Mock<ProfilesDb>;
  let repService: Mock<RepService>;
  let profileActivityLogsDb: Mock<ProfileActivityLogsDb>;

  beforeEach(() => {
    profilesDb = mockDbService();
    ratingsDb = mockDbService();
    profileActivityLogsDb = mockDbService();
    repService = mock(RepService);
    ratingsService = new RatingsService(
      ratingsDb,
      profilesDb,
      repService,
      profileActivityLogsDb
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

  describe('getPageOfRatingsForMatter', () => {
    it('should call ratingsDb.searchRatingsForMatter and enhance results with levels', async () => {
      const request: RatingsSearchRequest = {
        matter: RateMatter.CIC,
        matter_target_id: 'a_matter_target_id',
        page_request: {
          page: 1,
          page_size: 10
        },
        rater_profile_id: 'a_profile_id'
      };
      when(repService.getRepForProfiles).mockResolvedValue({
        a_profile_id_1: 0,
        a_profile_id_2: 0
      });
      when(ratingsDb.searchRatingsForMatter).mockResolvedValue({
        data: [
          {
            rater_profile_id: 'a_profile_id_1',
            rater_handle: 'a_rater_handle_1',
            rater_tdh: 1,
            rating: 10,
            matter: RateMatter.CIC,
            matter_category: 'a_matter_category',
            last_modified: Time.millis(0).toDate(),
            rater_cic_rating: 1
          },
          {
            rater_profile_id: 'a_profile_id_2',
            rater_handle: 'a_rater_handle_2',
            rater_tdh: 10000,
            rating: 10,
            matter: RateMatter.CIC,
            matter_category: 'a_matter_category',
            last_modified: Time.millis(0).toDate(),
            rater_cic_rating: 2
          }
        ],
        page: 1,
        next: false,
        count: 2
      });
      const result = await ratingsService.getPageOfRatingsForMatter(request);

      expect(result).toEqual({
        data: [
          {
            rater_handle: 'a_rater_handle_1',
            rater_profile_id: 'a_profile_id_1',
            rater_tdh: 1,
            rating: 10,
            matter: RateMatter.CIC,
            matter_category: 'a_matter_category',
            last_modified: Time.millis(0).toDate(),
            rater_cic_rating: 1,
            rater_level: 0
          },
          {
            rater_handle: 'a_rater_handle_2',
            rater_profile_id: 'a_profile_id_2',
            rater_tdh: 10000,
            rating: 10,
            matter: RateMatter.CIC,
            matter_category: 'a_matter_category',
            last_modified: Time.millis(0).toDate(),
            rater_cic_rating: 2,
            rater_level: 11
          }
        ],
        page: 1,
        next: false,
        count: 2
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
          rater_profile_id: 'pid',
          matter: RateMatter.CIC,
          matter_target_id: 'mid',
          matter_category: 'mcat',
          rating: 10
        });
      }, 'Not enough TDH left to spend on this matter. Changing this vote would spend 4 TDH, but profile only has 2 left to spend');
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
          })
        },
        mockConnection
      );
    });
  });

  describe('revokeOverRates', () => {
    it('reduces all rates on matter when there TDH is overspent', async () => {
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
      expect(ratingsDb.updateRating).toBeCalledWith(
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
      expect(ratingsDb.updateRating).toBeCalledWith(
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
      expect(profileActivityLogsDb.insert).toBeCalledWith(
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
          })
        },
        mockConnection
      );
      expect(profileActivityLogsDb.insert).toBeCalledWith(
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
          })
        },
        mockConnection
      );
    });

    it('reduces some rates on matter when there TDH is overspent', async () => {
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
          })
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
    });
  });
});
