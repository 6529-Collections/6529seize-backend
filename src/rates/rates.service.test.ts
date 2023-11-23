import { RatesService } from './rates.service';
import { resetAllWhenMocks, when } from 'jest-when';
import { RateMatterTargetType } from '../entities/IRateMatter';
import { RatesDb } from './rates.db';
import { RateEventReason } from '../entities/IRateEvent';
import { Time } from '../time';
import {
  expectExceptionWithMessage,
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
      when(ratesDb.getAllTdhs).mockResolvedValue([]);
      when(
        ratesDb.getActiveRateTalliesGroupedByRaterMatterAndTarget
      ).mockResolvedValue([]);
      await service.revokeOverRates();
      expect(ratesDb.insertRateEvent).toBeCalledTimes(0);
    });

    it('tdh owners exists but no rates given', async () => {
      when(ratesDb.getAllTdhs).mockResolvedValue([
        { tdh: 10, wallets: ['0xwallet'] }
      ]);
      when(
        ratesDb.getActiveRateTalliesGroupedByRaterMatterAndTarget
      ).mockResolvedValue([]);
      await service.revokeOverRates();
      expect(ratesDb.insertRateEvent).toBeCalledTimes(0);
    });

    it('tdh owners has rated in limits', async () => {
      when(ratesDb.getAllTdhs).mockResolvedValue([
        { tdh: 10, wallets: ['0xwallet'] }
      ]);
      when(
        ratesDb.getActiveRateTalliesGroupedByRaterMatterAndTarget
      ).mockResolvedValue([
        {
          rater: '0xwallet',
          matter: 'aMatter',
          matter_target_type: RateMatterTargetType.PROFILE_ID,
          rate_tally: 1
        }
      ]);
      await service.revokeOverRates();
      expect(ratesDb.insertRateEvent).toBeCalledTimes(0);
    });

    it('tdh owners has rated over limits', async () => {
      when(ratesDb.getAllTdhs).mockResolvedValue([
        { tdh: 10, wallets: ['0xwallet'] }
      ]);
      when(
        ratesDb.getActiveRateTalliesGroupedByRaterMatterAndTarget
      ).mockResolvedValue([
        {
          rater: '0xwallet',
          matter: 'aMatter',
          matter_target_type: RateMatterTargetType.PROFILE_ID,
          rate_tally: 11
        }
      ]);
      when(ratesDb.getToBeRevokedEvents).mockResolvedValue([
        {
          id: '1',
          rater: '0xwallet',
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
          rater: '0xwallet'
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
        ratesDb.getRatesTallyForWalletOnMatterByCategories
      ).mockResolvedValue({
        cat1: 2
      });
      const result = await service.getCategoriesInfoOnMatter({
        wallets: ['wallet1', 'wallet2'],
        matterTargetType: RateMatterTargetType.PROFILE_ID,
        matter: 'CIC',
        matterTargetId: '123'
      });
      expect(result).toStrictEqual([
        {
          authenticated_wallet_rates: 2,
          category_display_name: 'Mat1',
          category_enabled: true,
          category_media: {
            hello: 'world'
          },
          category_tag: 'cat1',
          tally: 5
        },
        {
          authenticated_wallet_rates: 0,
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
      when(ratesDb.getTdhInfoForWallet).mockResolvedValue({
        block: 1,
        tdh: 10,
        wallets: [
          '0x0000000000000000000000000000000000000000',
          '0x0000000000000000000000000000000000000001'
        ]
      });
      when(ratesDb.getTotalRatesSpentOnMatterByWallets).mockResolvedValue(5);
      const result = await service.getRatesLeftOnMatterForWallet({
        wallet: '0x0000000000000000000000000000000000000000',
        matterTargetType: RateMatterTargetType.PROFILE_ID,
        matter: 'CIC'
      });
      expect(result).toStrictEqual({
        consolidatedWallets: [
          '0x0000000000000000000000000000000000000000',
          '0x0000000000000000000000000000000000000001'
        ],
        ratesLeft: 5,
        ratesSpent: 5
      });
    });
  });

  describe('registerUserRating', () => {
    it('unknown category', async () => {
      when(
        ratesDb.getRatesTallyForWalletOnMatterByCategories
      ).mockResolvedValue({});
      when(ratesDb.getCategoriesForMatter).mockResolvedValue([]);
      await expectExceptionWithMessage(async () => {
        await service.registerUserRating({
          rater: '0x0000000000000000000000000000000000000000',
          matterTargetType: RateMatterTargetType.PROFILE_ID,
          matter: 'CIC',
          matterTargetId: 'id1',
          category: 'cat1',
          amount: 5
        });
      }, 'Tried to rate on matter with category cat1 but no active category with such tag exists for this matter');
    });

    it('not enough rates', async () => {
      when(ratesDb.getTotalRatesSpentOnMatterByWallets).mockResolvedValue(0);
      when(
        ratesDb.getRatesTallyForWalletOnMatterByCategories
      ).mockResolvedValue({
        cat1: 5
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
          disabled_time: null
        }
      ]);
      await expectExceptionWithMessage(async () => {
        await service.registerUserRating({
          rater: '0x0000000000000000000000000000000000000000',
          matterTargetType: RateMatterTargetType.PROFILE_ID,
          matter: 'MAT1',
          matterTargetId: 'id1',
          category: 'cat1',
          amount: 5
        });
      }, 'Wallet tried to give 5 rates on matter without enough rates left. Rates left: 0');
    });

    it('revoking more than given not allowed', async () => {
      when(ratesDb.getTotalRatesSpentOnMatterByWallets).mockResolvedValue(0);
      when(
        ratesDb.getRatesTallyForWalletOnMatterByCategories
      ).mockResolvedValue({
        cat1: 5
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
          disabled_time: null
        }
      ]);
      await expectExceptionWithMessage(async () => {
        await service.registerUserRating({
          rater: '0x0000000000000000000000000000000000000000',
          matterTargetType: RateMatterTargetType.PROFILE_ID,
          matter: 'MAT1',
          matterTargetId: 'id1',
          category: 'cat1',
          amount: -6
        });
      }, 'Wallet tried to revoke 6 rates on matter and category but has only historically given 5 rates');
    });

    it('rate on a disabled matter not allowed', async () => {
      when(ratesDb.getTdhInfoForWallet).mockResolvedValue({
        block: 1,
        tdh: 5,
        wallets: ['0x0000000000000000000000000000000000000000']
      });
      when(ratesDb.getTotalRatesSpentOnMatterByWallets).mockResolvedValue(2);
      when(
        ratesDb.getRatesTallyForWalletOnMatterByCategories
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
          rater: '0x0000000000000000000000000000000000000000',
          matterTargetType: RateMatterTargetType.PROFILE_ID,
          matter: 'MAT1',
          matterTargetId: 'id1',
          category: 'cat1',
          amount: 2
        });
      }, 'Tried to rate on matter with category cat1 but no active category with such tag exists for this matter');
    });

    it('rate successfully', async () => {
      when(ratesDb.getTdhInfoForWallet).mockResolvedValue({
        block: 1,
        tdh: 5,
        wallets: ['0x0000000000000000000000000000000000000000']
      });
      when(ratesDb.getTotalRatesSpentOnMatterByWallets).mockResolvedValue(2);
      when(
        ratesDb.getRatesTallyForWalletOnMatterByCategories
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
          disabled_time: null
        }
      ]);
      await service.registerUserRating({
        rater: '0x0000000000000000000000000000000000000000',
        matterTargetType: RateMatterTargetType.PROFILE_ID,
        matter: 'MAT1',
        matterTargetId: 'id1',
        category: 'cat1',
        amount: 2
      });
      expect(ratesDb.insertRateEvent).toBeCalledWith({
        amount: 2,
        created_time: expect.anything(),
        event_reason: 'USER_RATED',
        id: expect.anything(),
        matter: 'MAT1',
        matter_category: 'cat1',
        matter_target_id: 'id1',
        matter_target_type: 'PROFILE_ID',
        rater: '0x0000000000000000000000000000000000000000'
      });
    });

    it('revoke rating successfully', async () => {
      when(ratesDb.getTdhInfoForWallet).mockResolvedValue({
        block: 1,
        tdh: 5,
        wallets: ['0x0000000000000000000000000000000000000000']
      });
      when(ratesDb.getTotalRatesSpentOnMatterByWallets).mockResolvedValue(2);
      when(
        ratesDb.getRatesTallyForWalletOnMatterByCategories
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
          disabled_time: null
        }
      ]);
      await service.registerUserRating({
        rater: '0x0000000000000000000000000000000000000000',
        matterTargetType: RateMatterTargetType.PROFILE_ID,
        matter: 'MAT1',
        matterTargetId: 'id1',
        category: 'cat1',
        amount: -2
      });
      expect(ratesDb.insertRateEvent).toBeCalledWith({
        amount: -2,
        created_time: expect.anything(),
        event_reason: 'USER_RATED',
        id: expect.anything(),
        matter: 'MAT1',
        matter_category: 'cat1',
        matter_target_id: 'id1',
        matter_target_type: 'PROFILE_ID',
        rater: '0x0000000000000000000000000000000000000000'
      });
    });

    it('revoke rating on a disabled matter successfully', async () => {
      when(ratesDb.getTdhInfoForWallet).mockResolvedValue({
        block: 1,
        tdh: 5,
        wallets: ['0x0000000000000000000000000000000000000000']
      });
      when(ratesDb.getTotalRatesSpentOnMatterByWallets).mockResolvedValue(2);
      when(
        ratesDb.getRatesTallyForWalletOnMatterByCategories
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
        rater: '0x0000000000000000000000000000000000000000',
        matterTargetType: RateMatterTargetType.PROFILE_ID,
        matter: 'MAT1',
        matterTargetId: 'id1',
        category: 'cat1',
        amount: -2
      });
      expect(ratesDb.insertRateEvent).toBeCalledWith({
        amount: -2,
        created_time: expect.anything(),
        event_reason: 'USER_RATED',
        id: expect.anything(),
        matter: 'MAT1',
        matter_category: 'cat1',
        matter_target_id: 'id1',
        matter_target_type: 'PROFILE_ID',
        rater: '0x0000000000000000000000000000000000000000'
      });
    });
  });
});
