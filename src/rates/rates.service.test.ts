import { RatesService } from './rates.service';
import { resetAllWhenMocks, when } from 'jest-when';
import { RateMatterTargetType } from '../entities/IRateMatter';
import { RatesDb } from './rates.db';
import { RateEventReason } from '../entities/IRateEvent';
import { Time } from '../time';
import {
  expectExceptionWithMessage,
  mockConnection,
  mockDbService
} from '../tests/test.helper';

describe('RatesService', () => {
  let service: RatesService;
  let ratesDb: RatesDb;

  beforeEach(() => {
    ratesDb = mockDbService(RatesDb);
    service = new RatesService(ratesDb);
  });

  afterEach(() => {
    resetAllWhenMocks();
    jest.resetAllMocks();
  });

  describe('revokeOverRates', () => {
    it('empty ratesDb', async () => {
      when(ratesDb.getAllProfilesTdhs).mockResolvedValue([]);
      when(
        ratesDb.getActiveRateTalliesGroupedByRaterMatterAndTarget
      ).mockResolvedValue([]);
      await service.revokeOverRates();
      expect(ratesDb.insertRateEvent).toBeCalledTimes(0);
    });

    it('tdh owners exists but no rates given', async () => {
      when(ratesDb.getAllProfilesTdhs).mockResolvedValue([
        { tdh: 10, profile_id: 'pid123' }
      ]);
      when(
        ratesDb.getActiveRateTalliesGroupedByRaterMatterAndTarget
      ).mockResolvedValue([]);
      await service.revokeOverRates();
      expect(ratesDb.insertRateEvent).toBeCalledTimes(0);
    });

    it('tdh owners has rated in limits', async () => {
      when(ratesDb.getAllProfilesTdhs).mockResolvedValue([
        { tdh: 10, profile_id: 'pid123' }
      ]);
      when(
        ratesDb.getActiveRateTalliesGroupedByRaterMatterAndTarget
      ).mockResolvedValue([
        {
          rater: 'pid123',
          matter: 'aMatter',
          matter_target_type: RateMatterTargetType.PROFILE_ID,
          rate_tally: 1
        }
      ]);
      await service.revokeOverRates();
      expect(ratesDb.insertRateEvent).toBeCalledTimes(0);
    });

    it('tdh owners has rated over limits', async () => {
      when(ratesDb.getAllProfilesTdhs).mockResolvedValue([
        { tdh: 10, profile_id: 'pid123' }
      ]);
      when(
        ratesDb.getActiveRateTalliesGroupedByRaterMatterAndTarget
      ).mockResolvedValue([
        {
          rater: 'pid123',
          matter: 'aMatter',
          matter_target_type: RateMatterTargetType.PROFILE_ID,
          rate_tally: 11
        }
      ]);
      when(ratesDb.getToBeRevokedEvents).mockResolvedValue([
        {
          id: '1',
          rater: 'pid123',
          matter_target_id: 'testId',
          matter: 'testMatter',
          matter_category: 'testCategory',
          matter_target_type: RateMatterTargetType.PROFILE_ID,
          event_reason: RateEventReason.TDH_CHANGED,
          amount: 1,
          created_time: new Date()
        }
      ]);
      await service.revokeOverRates();
      expect(ratesDb.insertRateEvent).toBeCalledWith(
        {
          amount: -1,
          created_time: expect.anything(),
          event_reason: 'TDH_CHANGED',
          id: expect.anything(),
          matter: 'testMatter',
          matter_category: 'testCategory',
          matter_target_id: 'testId',
          matter_target_type: 'PROFILE_ID',
          rater: 'pid123'
        },
        { connection: {} }
      );
    });
  });

  describe('getCategoriesInfoOnMatter', () => {
    it('groups tallies by categories', async () => {
      when(ratesDb.getCategoriesForMatter).mockResolvedValue([
        {
          id: 'id1',
          matter: 'MAT1',
          matter_target_type: RateMatterTargetType.PROFILE_ID,
          matter_category_display_name: 'Mat1',
          matter_category_media: '{"hello": "world"}',
          created_time: Time.millis(0).toDate(),
          matter_category_tag: 'cat1',
          disabled_time: null
        },
        {
          id: 'id2',
          matter: 'MAT2',
          matter_target_type: RateMatterTargetType.PROFILE_ID,
          matter_category_display_name: 'Mat2',
          matter_category_media: null,
          created_time: Time.millis(0).toDate(),
          matter_category_tag: 'cat2',
          disabled_time: Time.yesterday().toDate()
        }
      ]);
      when(ratesDb.getTotalTalliesByCategories).mockResolvedValue({ cat1: 5 });
      when(
        ratesDb.getRatesTallyForProfileOnMatterByCategories
      ).mockResolvedValue({
        cat1: 2
      });
      const result = await service.getCategoriesInfoOnMatter({
        profileId: 'pid123',
        matterTargetType: RateMatterTargetType.PROFILE_ID,
        matter: 'CIC',
        matterTargetId: '123'
      });
      expect(result).toStrictEqual([
        {
          authenticated_profile_rates: 2,
          category_display_name: 'Mat1',
          category_enabled: true,
          category_media: {
            hello: 'world'
          },
          category_tag: 'cat1',
          tally: 5
        },
        {
          authenticated_profile_rates: 0,
          category_display_name: 'Mat2',
          category_enabled: false,
          category_media: {},
          category_tag: 'cat2',
          tally: 0
        }
      ]);
    });
  });

  describe('getRatesLeftOnMatterForWallet', () => {
    it('gives correct rates left count', async () => {
      when(ratesDb.getTdhInfoForProfile).mockResolvedValue(10);
      when(ratesDb.getRatesTallyOnMatterByProfileId).mockResolvedValue(5);
      const result = await service.getRatesLeftOnMatterForProfile({
        profileId: 'pid123',
        matterTargetType: RateMatterTargetType.PROFILE_ID,
        matter: 'CIC'
      });
      expect(result).toStrictEqual({
        ratesLeft: 5,
        ratesSpent: 5
      });
    });
  });

  describe('registerUserRating', () => {
    it('unknown category', async () => {
      when(
        ratesDb.getRatesTallyForProfileOnMatterByCategories
      ).mockResolvedValue({});
      when(ratesDb.getRatesTallyOnMatterByProfileId).mockResolvedValue(0);
      when(ratesDb.getCategoriesForMatter).mockResolvedValue([]);
      await expectExceptionWithMessage(async () => {
        await service.registerUserRating({
          raterProfileId: 'pid123',
          matterTargetType: RateMatterTargetType.PROFILE_ID,
          matter: 'CIC',
          matterTargetId: 'id1',
          category: 'cat1',
          amount: 5,
          connectionHolder: mockConnection
        });
      }, 'Profile tried to rate on matter with category cat1 but no active category with such tag exists for this matter. If this is a legacy matter then you can only take away all your already given rates.');
    });

    it('adding positive rating to an already positive rating over TDH not allowed', async () => {
      when(ratesDb.getRatesTallyOnMatterByProfileId).mockResolvedValue(5);
      when(ratesDb.getTdhInfoForProfile).mockResolvedValue(5);
      when(ratesDb.getCategoriesForMatter).mockResolvedValue([
        {
          id: 'id1',
          matter: 'MAT1',
          matter_target_type: RateMatterTargetType.PROFILE_ID,
          matter_category_display_name: 'Mat1',
          matter_category_media: '{"hello": "world"}',
          created_time: Time.millis(0).toDate(),
          matter_category_tag: 'cat1',
          disabled_time: null
        }
      ]);
      await expectExceptionWithMessage(async () => {
        await service.registerUserRating({
          raterProfileId: 'pid123',
          matterTargetType: RateMatterTargetType.PROFILE_ID,
          matter: 'MAT1',
          matterTargetId: 'id1',
          category: 'cat1',
          amount: 1,
          connectionHolder: mockConnection
        });
      }, 'Can not rate. Not enough TDH.');
    });

    it('adding positive rating to an already positive rating in limits of TDH allowed', async () => {
      when(ratesDb.getRatesTallyOnMatterByProfileId).mockResolvedValue(4);
      when(ratesDb.getTdhInfoForProfile).mockResolvedValue(5);
      when(ratesDb.getCategoriesForMatter).mockResolvedValue([
        {
          id: 'id1',
          matter: 'MAT1',
          matter_target_type: RateMatterTargetType.PROFILE_ID,
          matter_category_display_name: 'Mat1',
          matter_category_media: '{"hello": "world"}',
          created_time: Time.millis(0).toDate(),
          matter_category_tag: 'cat1',
          disabled_time: null
        }
      ]);
      await service.registerUserRating({
        raterProfileId: 'pid123',
        matterTargetType: RateMatterTargetType.PROFILE_ID,
        matter: 'MAT1',
        matterTargetId: 'id1',
        category: 'cat1',
        amount: 1,
        connectionHolder: mockConnection
      });
      expect(ratesDb.insertRateEvent).toBeCalledWith(
        {
          amount: 1,
          created_time: expect.anything(),
          event_reason: 'USER_RATED',
          id: expect.anything(),
          matter: 'MAT1',
          matter_category: 'cat1',
          matter_target_id: 'id1',
          matter_target_type: 'PROFILE_ID',
          rater: 'pid123'
        },
        mockConnection
      );
    });

    it('changing from positive to negative rating more than allowed', async () => {
      when(ratesDb.getRatesTallyOnMatterByProfileId).mockResolvedValue(5);
      when(ratesDb.getTdhInfoForProfile).mockResolvedValue(5);
      when(ratesDb.getCategoriesForMatter).mockResolvedValue([
        {
          id: 'id1',
          matter: 'MAT1',
          matter_target_type: RateMatterTargetType.PROFILE_ID,
          matter_category_display_name: 'Mat1',
          matter_category_media: '{"hello": "world"}',
          created_time: Time.millis(0).toDate(),
          matter_category_tag: 'cat1',
          disabled_time: null
        }
      ]);
      await expectExceptionWithMessage(async () => {
        await service.registerUserRating({
          raterProfileId: 'pid123',
          matterTargetType: RateMatterTargetType.PROFILE_ID,
          matter: 'MAT1',
          matterTargetId: 'id1',
          category: 'cat1',
          amount: -11,
          connectionHolder: mockConnection
        });
      }, 'Can not rate. Not enough TDH.');
    });

    it('cant rate CIC on itself', async () => {
      await expectExceptionWithMessage(async () => {
        await service.registerUserRating({
          raterProfileId: 'pid123',
          matterTargetType: RateMatterTargetType.PROFILE_ID,
          matter: 'CIC',
          matterTargetId: 'pid123',
          category: 'cat1',
          amount: 2,
          connectionHolder: mockConnection
        });
      }, 'Users cannot rate themselves');
    });

    it('changing from positive to negative rating in allowed limits', async () => {
      when(ratesDb.getRatesTallyOnMatterByProfileId).mockResolvedValue(5);
      when(ratesDb.getTdhInfoForProfile).mockResolvedValue(5);
      when(ratesDb.getCategoriesForMatter).mockResolvedValue([
        {
          id: 'id1',
          matter: 'MAT1',
          matter_target_type: RateMatterTargetType.PROFILE_ID,
          matter_category_display_name: 'Mat1',
          matter_category_media: '{"hello": "world"}',
          created_time: Time.millis(0).toDate(),
          matter_category_tag: 'cat1',
          disabled_time: null
        }
      ]);
      await service.registerUserRating({
        raterProfileId: 'pid123',
        matterTargetType: RateMatterTargetType.PROFILE_ID,
        matter: 'MAT1',
        matterTargetId: 'id1',
        category: 'cat1',
        amount: -10,
        connectionHolder: mockConnection
      });
      expect(ratesDb.insertRateEvent).toBeCalledWith(
        {
          amount: -10,
          created_time: expect.anything(),
          event_reason: 'USER_RATED',
          id: expect.anything(),
          matter: 'MAT1',
          matter_category: 'cat1',
          matter_target_id: 'id1',
          matter_target_type: 'PROFILE_ID',
          rater: 'pid123'
        },
        mockConnection
      );
    });

    it('rate on a disabled matter not allowed', async () => {
      when(ratesDb.getTdhInfoForProfile).mockResolvedValue(5);
      when(ratesDb.getRatesTallyOnMatterByProfileId).mockResolvedValue(2);
      when(
        ratesDb.getRatesTallyForProfileOnMatterByCategories
      ).mockResolvedValue({
        cat1: 0
      });
      when(ratesDb.getCategoriesForMatter).mockResolvedValue([
        {
          id: 'id1',
          matter: 'MAT1',
          matter_target_type: RateMatterTargetType.PROFILE_ID,
          matter_category_display_name: 'Mat1',
          matter_category_media: '{"hello": "world"}',
          created_time: Time.millis(0).toDate(),
          matter_category_tag: 'cat1',
          disabled_time: Time.yesterday().minusDays(1).toDate()
        }
      ]);
      await expectExceptionWithMessage(async () => {
        await service.registerUserRating({
          raterProfileId: 'pid123',
          matterTargetType: RateMatterTargetType.PROFILE_ID,
          matter: 'MAT1',
          matterTargetId: 'id1',
          category: 'cat1',
          amount: 2,
          connectionHolder: mockConnection
        });
      }, 'Profile tried to rate on matter with category cat1 but no active category with such tag exists for this matter. If this is a legacy matter then you can only take away all your already given rates.');
    });

    it('revoke rating on a disabled matter successfully', async () => {
      when(ratesDb.getTdhInfoForProfile).mockResolvedValue(5);
      when(ratesDb.getRatesTallyOnMatterByProfileId).mockResolvedValue(2);
      when(
        ratesDb.getRatesTallyForProfileOnMatterByCategories
      ).mockResolvedValue({
        cat1: 2
      });
      when(ratesDb.getCategoriesForMatter).mockResolvedValue([
        {
          id: 'id1',
          matter: 'MAT1',
          matter_target_type: RateMatterTargetType.PROFILE_ID,
          matter_category_display_name: 'Mat1',
          matter_category_media: '{"hello": "world"}',
          created_time: Time.millis(0).toDate(),
          matter_category_tag: 'cat1',
          disabled_time: Time.yesterday().minusDays(1).toDate()
        }
      ]);
      await service.registerUserRating({
        raterProfileId: 'pid123',
        matterTargetType: RateMatterTargetType.PROFILE_ID,
        matter: 'MAT1',
        matterTargetId: 'id1',
        category: 'cat1',
        amount: -2,
        connectionHolder: mockConnection
      });
      expect(ratesDb.insertRateEvent).toBeCalledWith(
        {
          amount: -2,
          created_time: expect.anything(),
          event_reason: 'USER_RATED',
          id: expect.anything(),
          matter: 'MAT1',
          matter_category: 'cat1',
          matter_target_id: 'id1',
          matter_target_type: 'PROFILE_ID',
          rater: 'pid123'
        },
        mockConnection
      );
    });
  });
});
