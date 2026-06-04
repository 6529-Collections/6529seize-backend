const mockFindWaves = jest.fn();
const mockFindOfficialWaves = jest.fn();
const mockFindDropsFeed = jest.fn();
const mockFindWaveCurationDrops = jest.fn();
const mockSearchDropsContainingPhraseInWave = jest.fn();
const mockSearchConcludedWaveDecisionsV2 = jest.fn();
const mockFindLeaderboardV2 = jest.fn();
const mockGetAuthenticationContext = jest.fn();
const mockGetFromRequest = jest.fn();

jest.mock('@/api/auth/auth', () => ({
  getAuthenticationContext: mockGetAuthenticationContext
}));

jest.mock('@/api/drops/drops.api.service', () => ({
  dropsService: {
    findLeaderboardV2: mockFindLeaderboardV2
  }
}));

jest.mock('@/api/waves/api-wave-v2.service', () => ({
  apiWaveV2Service: {
    findWaves: mockFindWaves,
    findOfficialWaves: mockFindOfficialWaves,
    findDropsFeed: mockFindDropsFeed,
    findWaveCurationDrops: mockFindWaveCurationDrops,
    searchDropsContainingPhraseInWave: mockSearchDropsContainingPhraseInWave
  }
}));

jest.mock('@/api/waves/wave-decisions-api.service', () => ({
  waveDecisionsApiService: {
    searchConcludedWaveDecisionsV2: mockSearchConcludedWaveDecisionsV2
  },
  WaveDecisionsQuerySort: {
    decision_time: 'decision_time'
  }
}));

jest.mock('@/drops/drops.db', () => ({
  LeaderboardSort: {
    RANK: 'RANK',
    REALTIME_VOTE: 'REALTIME_VOTE',
    MY_REALTIME_VOTE: 'MY_REALTIME_VOTE',
    CREATED_AT: 'CREATED_AT',
    PRICE: 'PRICE',
    RATING_PREDICTION: 'RATING_PREDICTION',
    TREND: 'TREND'
  }
}));

jest.mock('@/time', () => ({
  Time: {
    minutes: jest.fn(() => ({
      toMillis: jest.fn(() => 60000)
    }))
  },
  Timer: {
    getFromRequest: mockGetFromRequest
  }
}));

import { ApiDropSearchStrategy } from '@/api/generated/models/ApiDropSearchStrategy';
import { ApiDropType } from '@/api/generated/models/ApiDropType';
import { ApiWavesOverviewType } from '@/api/generated/models/ApiWavesOverviewType';
import { ApiWavesPinFilter } from '@/api/generated/models/ApiWavesPinFilter';
import { ApiWavesV2ListType } from '@/api/generated/models/ApiWavesV2ListType';
import { PageSortDirection } from '@/api/page-request';
import { LeaderboardSort } from '@/drops/drops.db';
import {
  handleGetWaveDecisionsV2,
  handleGetWaveDropsV2,
  handleGetWaveLeaderboardV2,
  handleGetOfficialWaves,
  handleGetWavesV2,
  handleListWaveCurationDropsV2,
  handleSearchDropsInWaveV2
} from './waves-v2.handlers';

describe('waves v2 handlers', () => {
  const timer = { marker: 'timer' } as any;
  const authenticationContext = { marker: 'auth' } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAuthenticationContext.mockResolvedValue(authenticationContext);
    mockGetFromRequest.mockReturnValue(timer);
  });

  describe('handleGetWavesV2', () => {
    const result = { data: [], count: 0, page: 1, next: false } as any;

    beforeEach(() => {
      mockFindWaves.mockResolvedValue(result);
    });

    it('applies search view defaults before calling the service', async () => {
      const req = { query: {} } as any;

      await expect(handleGetWavesV2(req)).resolves.toBe(result);

      expect(mockGetFromRequest).toHaveBeenCalledWith(req);
      expect(mockGetAuthenticationContext).toHaveBeenCalledWith(req, timer);
      expect(mockFindWaves).toHaveBeenCalledWith(
        {
          view: ApiWavesV2ListType.Search,
          page: 1,
          page_size: 20
        },
        {
          authenticationContext,
          timer
        }
      );
    });

    it('normalizes overview query params before calling the service', async () => {
      const req = {
        query: {
          view: 'overview',
          overview_type: 'most_subscribed',
          only_waves_followed_by_authenticated_user: 'true',
          direct_message: 'false',
          pinned: 'pinned'
        }
      } as any;

      await handleGetWavesV2(req);

      expect(mockFindWaves).toHaveBeenCalledWith(
        {
          view: ApiWavesV2ListType.Overview,
          page: 1,
          page_size: 10,
          overview_type: ApiWavesOverviewType.MostSubscribed,
          only_waves_followed_by_authenticated_user: true,
          direct_message: false,
          pinned: ApiWavesPinFilter.Pinned
        },
        {
          authenticationContext,
          timer
        }
      );
    });

    it('rejects query params outside the active view schema', async () => {
      const req = { query: { unexpected: 'value' } } as any;

      await expect(handleGetWavesV2(req)).rejects.toThrow(
        '"unexpected" is not allowed'
      );
      expect(mockFindWaves).not.toHaveBeenCalled();
    });
  });

  describe('handleGetOfficialWaves', () => {
    const result = [{ id: 'wave-1' }] as any;

    beforeEach(() => {
      mockFindOfficialWaves.mockResolvedValue(result);
    });

    it('passes authenticated request context to the service', async () => {
      const req = { query: {} } as any;

      await expect(handleGetOfficialWaves(req)).resolves.toBe(result);

      expect(mockGetFromRequest).toHaveBeenCalledWith(req);
      expect(mockGetAuthenticationContext).toHaveBeenCalledWith(req, timer);
      expect(mockFindOfficialWaves).toHaveBeenCalledWith({
        authenticationContext,
        timer
      });
    });
  });

  describe('handleGetWaveDropsV2', () => {
    const result = { drops: [], latest_serial_no: 1 } as any;

    beforeEach(() => {
      mockFindDropsFeed.mockResolvedValue(result);
    });

    it('applies feed defaults before calling the service', async () => {
      const req = { params: { id: 'wave-1' }, query: {} } as any;

      await expect(handleGetWaveDropsV2(req)).resolves.toBe(result);

      expect(mockGetFromRequest).toHaveBeenCalledWith(req);
      expect(mockGetAuthenticationContext).toHaveBeenCalledWith(req, timer);
      expect(mockFindDropsFeed).toHaveBeenCalledWith(
        {
          wave_id: 'wave-1',
          drop_id: null,
          amount: 50,
          serial_no_limit: null,
          search_strategy: ApiDropSearchStrategy.Older,
          drop_type: null,
          curation_id: null
        },
        {
          authenticationContext,
          timer
        }
      );
    });

    it('normalizes feed query params before calling the service', async () => {
      const req = {
        params: { id: 'wave-1' },
        query: {
          limit: '25',
          serial_no_limit: '100',
          search_strategy: ApiDropSearchStrategy.Newer,
          drop_type: ApiDropType.Chat
        }
      } as any;

      await handleGetWaveDropsV2(req);

      expect(mockFindDropsFeed).toHaveBeenCalledWith(
        {
          wave_id: 'wave-1',
          drop_id: null,
          amount: 25,
          serial_no_limit: 100,
          search_strategy: ApiDropSearchStrategy.Newer,
          drop_type: ApiDropType.Chat,
          curation_id: null
        },
        {
          authenticationContext,
          timer
        }
      );
    });

    it('rejects invalid path params', async () => {
      const req = { params: {}, query: {} } as any;

      await expect(handleGetWaveDropsV2(req)).rejects.toThrow(
        '"id" is required'
      );
      expect(mockFindDropsFeed).not.toHaveBeenCalled();
    });
  });

  describe('handleListWaveCurationDropsV2', () => {
    const result = { data: [], page: 1, next: false } as any;

    beforeEach(() => {
      mockFindWaveCurationDrops.mockResolvedValue(result);
    });

    it('applies query defaults before calling the service', async () => {
      const req = {
        params: { id: 'wave-1', curation_id: 'curation-1' },
        query: {}
      } as any;

      await expect(handleListWaveCurationDropsV2(req)).resolves.toBe(result);

      expect(mockGetFromRequest).toHaveBeenCalledWith(req);
      expect(mockGetAuthenticationContext).toHaveBeenCalledWith(req, timer);
      expect(mockFindWaveCurationDrops).toHaveBeenCalledWith(
        {
          wave_id: 'wave-1',
          curation_id: 'curation-1',
          page: 1,
          page_size: 50
        },
        {
          authenticationContext,
          timer
        }
      );
    });

    it('normalizes query params before calling the service', async () => {
      const req = {
        params: { id: 'wave-1', curation_id: 'curation-1' },
        query: { page: '2', page_size: '25' }
      } as any;

      await handleListWaveCurationDropsV2(req);

      expect(mockFindWaveCurationDrops).toHaveBeenCalledWith(
        {
          wave_id: 'wave-1',
          curation_id: 'curation-1',
          page: 2,
          page_size: 25
        },
        {
          authenticationContext,
          timer
        }
      );
    });

    it('rejects invalid query params', async () => {
      const req = {
        params: { id: 'wave-1', curation_id: 'curation-1' },
        query: { page_size: '101' }
      } as any;

      await expect(handleListWaveCurationDropsV2(req)).rejects.toThrow(
        '"page_size" must be less than or equal to 100'
      );
      expect(mockFindWaveCurationDrops).not.toHaveBeenCalled();
    });
  });

  describe('handleGetWaveDecisionsV2', () => {
    const result = { data: [], count: 0, page: 1, next: false } as any;

    beforeEach(() => {
      mockSearchConcludedWaveDecisionsV2.mockResolvedValue(result);
    });

    it('applies query defaults before calling the service', async () => {
      const req = { params: { id: 'wave-1' }, query: {} } as any;

      await expect(handleGetWaveDecisionsV2(req)).resolves.toBe(result);

      expect(mockGetFromRequest).toHaveBeenCalledWith(req);
      expect(mockGetAuthenticationContext).toHaveBeenCalledWith(req, timer);
      expect(mockSearchConcludedWaveDecisionsV2).toHaveBeenCalledWith(
        {
          wave_id: 'wave-1',
          page_size: 100,
          page: 1,
          is_additional_action_promised: null,
          sort_direction: PageSortDirection.DESC,
          sort: 'decision_time'
        },
        {
          authenticationContext,
          timer
        }
      );
    });

    it('normalizes query params before calling the service', async () => {
      const req = {
        params: { id: 'wave-1' },
        query: {
          page_size: '50',
          page: '2',
          is_additional_action_promised: 'false',
          sort_direction: PageSortDirection.ASC,
          sort: 'decision_time'
        }
      } as any;

      await handleGetWaveDecisionsV2(req);

      expect(mockSearchConcludedWaveDecisionsV2).toHaveBeenCalledWith(
        {
          wave_id: 'wave-1',
          page_size: 50,
          page: 2,
          is_additional_action_promised: false,
          sort_direction: PageSortDirection.ASC,
          sort: 'decision_time'
        },
        {
          authenticationContext,
          timer
        }
      );
    });

    it('rejects invalid query params', async () => {
      const req = {
        params: { id: 'wave-1' },
        query: { page_size: '2001' }
      } as any;

      await expect(handleGetWaveDecisionsV2(req)).rejects.toThrow(
        '"page_size" must be less than or equal to 2000'
      );
      expect(mockSearchConcludedWaveDecisionsV2).not.toHaveBeenCalled();
    });
  });

  describe('handleGetWaveLeaderboardV2', () => {
    const result = { data: [], count: 0, page: 1, next: false } as any;

    beforeEach(() => {
      mockFindLeaderboardV2.mockResolvedValue(result);
    });

    it('applies query defaults before calling the service', async () => {
      const req = { params: { id: 'wave-1' }, query: {} } as any;

      await expect(handleGetWaveLeaderboardV2(req)).resolves.toBe(result);

      expect(mockGetFromRequest).toHaveBeenCalledWith(req);
      expect(mockGetAuthenticationContext).toHaveBeenCalledWith(req, timer);
      expect(mockFindLeaderboardV2).toHaveBeenCalledWith(
        {
          wave_id: 'wave-1',
          page_size: 50,
          page: 1,
          curation_id: null,
          unvoted_by_me: false,
          is_additional_action_promised: null,
          price_currency: null,
          min_price: null,
          max_price: null,
          sort_direction: PageSortDirection.ASC,
          sort: LeaderboardSort.RANK
        },
        {
          authenticationContext,
          timer
        }
      );
    });

    it('normalizes query params before calling the service', async () => {
      const req = {
        params: { id: 'wave-1' },
        query: {
          page_size: '25',
          page: '2',
          curation_id: 'curation-1',
          unvoted_by_me: 'true',
          is_additional_action_promised: 'false',
          price_currency: 'eth',
          min_price: '1.5',
          max_price: '3',
          sort_direction: PageSortDirection.DESC,
          sort: LeaderboardSort.PRICE
        }
      } as any;

      await handleGetWaveLeaderboardV2(req);

      expect(mockFindLeaderboardV2).toHaveBeenCalledWith(
        {
          wave_id: 'wave-1',
          page_size: 25,
          page: 2,
          curation_id: 'curation-1',
          unvoted_by_me: true,
          is_additional_action_promised: false,
          price_currency: 'eth',
          min_price: 1.5,
          max_price: 3,
          sort_direction: PageSortDirection.DESC,
          sort: LeaderboardSort.PRICE
        },
        {
          authenticationContext,
          timer
        }
      );
    });

    it('rejects invalid query params', async () => {
      const req = {
        params: { id: 'wave-1' },
        query: { page_size: '101' }
      } as any;

      await expect(handleGetWaveLeaderboardV2(req)).rejects.toThrow(
        '"page_size" must be less than or equal to 100'
      );
      expect(mockFindLeaderboardV2).not.toHaveBeenCalled();
    });
  });

  describe('handleSearchDropsInWaveV2', () => {
    const result = { data: [], page: 1, next: false } as any;

    beforeEach(() => {
      mockSearchDropsContainingPhraseInWave.mockResolvedValue(result);
    });

    it('applies query defaults before calling the service', async () => {
      const req = {
        params: { waveId: 'wave-1' },
        query: { term: 'hello' }
      } as any;

      await expect(handleSearchDropsInWaveV2(req)).resolves.toBe(result);

      expect(mockGetFromRequest).toHaveBeenCalledWith(req);
      expect(mockGetAuthenticationContext).toHaveBeenCalledWith(req, timer);
      expect(mockSearchDropsContainingPhraseInWave).toHaveBeenCalledWith(
        {
          term: 'hello',
          page: 1,
          size: 20,
          wave_id: 'wave-1'
        },
        {
          authenticationContext,
          timer
        }
      );
    });

    it('normalizes query params before calling the service', async () => {
      const req = {
        params: { waveId: 'wave-1' },
        query: { term: 'hello', page: '2', size: '50' }
      } as any;

      await handleSearchDropsInWaveV2(req);

      expect(mockSearchDropsContainingPhraseInWave).toHaveBeenCalledWith(
        {
          term: 'hello',
          page: 2,
          size: 50,
          wave_id: 'wave-1'
        },
        {
          authenticationContext,
          timer
        }
      );
    });

    it('rejects invalid query params', async () => {
      const req = {
        params: { waveId: 'wave-1' },
        query: { term: '', size: '101' }
      } as any;

      await expect(handleSearchDropsInWaveV2(req)).rejects.toThrow(
        '"term" is not allowed to be empty'
      );
      expect(mockSearchDropsContainingPhraseInWave).not.toHaveBeenCalled();
    });
  });
});
