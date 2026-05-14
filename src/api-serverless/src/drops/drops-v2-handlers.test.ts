const mockFindBoostedDrops = jest.fn();
const mockFindCuratedProfileWaveDrops = jest.fn();
const mockFindDrops = jest.fn();
const mockFindWithWaveByIdOrThrow = jest.fn();
const mockFindMetadataByDropIdOrThrow = jest.fn();
const mockFindPartByDropIdOrThrow = jest.fn();
const mockFindBoostsByDropIdOrThrow = jest.fn();
const mockFindReactionsByDropIdOrThrow = jest.fn();
const mockFindVotersByDropIdOrThrow = jest.fn();
const mockFindVotersCsvByDropIdOrThrow = jest.fn();
const mockFindVoteEditLogsByDropIdOrThrow = jest.fn();
const mockGetAuthenticationContext = jest.fn();
const mockGetFromRequest = jest.fn();
const mockReturnCSVResult = jest.fn();

jest.mock('@/api/api-helpers', () => ({
  returnCSVResult: mockReturnCSVResult
}));

jest.mock('@/api/auth/auth', () => ({
  getAuthenticationContext: mockGetAuthenticationContext
}));

jest.mock('@/api/drops/api-drop-v2.service', () => ({
  apiDropV2Service: {
    findBoostedDrops: mockFindBoostedDrops,
    findCuratedProfileWaveDrops: mockFindCuratedProfileWaveDrops,
    findDrops: mockFindDrops,
    findWithWaveByIdOrThrow: mockFindWithWaveByIdOrThrow,
    findMetadataByDropIdOrThrow: mockFindMetadataByDropIdOrThrow,
    findPartByDropIdOrThrow: mockFindPartByDropIdOrThrow,
    findBoostsByDropIdOrThrow: mockFindBoostsByDropIdOrThrow,
    findReactionsByDropIdOrThrow: mockFindReactionsByDropIdOrThrow,
    findVotersByDropIdOrThrow: mockFindVotersByDropIdOrThrow,
    findVotersCsvByDropIdOrThrow: mockFindVotersCsvByDropIdOrThrow,
    findVoteEditLogsByDropIdOrThrow: mockFindVoteEditLogsByDropIdOrThrow
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

import { ApiPageSortDirection } from '@/api/generated/models/ApiPageSortDirection';
import { DEFAULT_PAGE_SIZE, PageSortDirection } from '@/api/page-request';
import {
  handleDownloadDropV2VotersById,
  handleGetBoostedDropsV2,
  handleGetCuratedProfileWaveDropsV2,
  handleGetDropsV2,
  handleGetDropV2BoostsById,
  handleGetDropV2ById,
  handleGetDropV2MetadataById,
  handleGetDropV2PartById,
  handleGetDropV2ReactionsById,
  handleGetDropV2VoteEditLogsById,
  handleGetDropV2VotersById
} from './drops-v2.handlers';

describe('drops v2 handlers', () => {
  const timer = { marker: 'timer' } as any;
  const authenticationContext = { marker: 'auth' } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAuthenticationContext.mockResolvedValue(authenticationContext);
    mockGetFromRequest.mockReturnValue(timer);
  });

  describe('handleGetBoostedDropsV2', () => {
    const result = { data: [], count: 0, page: 1, next: false } as any;

    beforeEach(() => {
      mockFindBoostedDrops.mockResolvedValue(result);
    });

    it('applies query defaults before calling the service', async () => {
      const req = { query: {} } as any;

      await expect(handleGetBoostedDropsV2(req)).resolves.toBe(result);

      expect(mockGetFromRequest).toHaveBeenCalledWith(req);
      expect(mockGetAuthenticationContext).toHaveBeenCalledWith(req, timer);
      expect(mockFindBoostedDrops).toHaveBeenCalledWith(
        {
          author: null,
          booster: null,
          wave_id: null,
          min_boosts: null,
          count_only_boosts_after: 1,
          page_size: DEFAULT_PAGE_SIZE,
          page: 1,
          sort_direction: ApiPageSortDirection.Desc,
          sort: 'last_boosted_at'
        },
        {
          timer,
          authenticationContext
        }
      );
    });

    it('normalizes query params before calling the service', async () => {
      const req = {
        query: {
          author: 'author-identity',
          booster: 'booster-identity',
          wave_id: 'wave-1',
          min_boosts: '3',
          count_only_boosts_after: '123',
          page_size: '25',
          page: '2',
          sort_direction: ApiPageSortDirection.Asc,
          sort: 'boosts'
        }
      } as any;

      await handleGetBoostedDropsV2(req);

      expect(mockFindBoostedDrops).toHaveBeenCalledWith(
        {
          author: 'author-identity',
          booster: 'booster-identity',
          wave_id: 'wave-1',
          min_boosts: 3,
          count_only_boosts_after: 123,
          page_size: 25,
          page: 2,
          sort_direction: ApiPageSortDirection.Asc,
          sort: 'boosts'
        },
        {
          timer,
          authenticationContext
        }
      );
    });

    it('rejects invalid query params', async () => {
      const req = { query: { page_size: '2001' } } as any;

      await expect(handleGetBoostedDropsV2(req)).rejects.toThrow(
        '"page_size" must be less than or equal to 2000'
      );
      expect(mockFindBoostedDrops).not.toHaveBeenCalled();
    });
  });

  describe('handleGetCuratedProfileWaveDropsV2', () => {
    const result = { data: [], page: 1, next: false } as any;

    beforeEach(() => {
      mockFindCuratedProfileWaveDrops.mockResolvedValue(result);
    });

    it('applies query defaults before calling the service', async () => {
      const req = { query: {} } as any;

      await expect(handleGetCuratedProfileWaveDropsV2(req)).resolves.toBe(
        result
      );

      expect(mockGetFromRequest).toHaveBeenCalledWith(req);
      expect(mockGetAuthenticationContext).toHaveBeenCalledWith(req, timer);
      expect(mockFindCuratedProfileWaveDrops).toHaveBeenCalledWith(
        {
          page: 1,
          page_size: DEFAULT_PAGE_SIZE
        },
        {
          authenticationContext,
          timer
        }
      );
    });

    it('normalizes query params before calling the service', async () => {
      const req = { query: { page: '2', page_size: '25' } } as any;

      await handleGetCuratedProfileWaveDropsV2(req);

      expect(mockFindCuratedProfileWaveDrops).toHaveBeenCalledWith(
        {
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
      const req = { query: { page_size: '2001' } } as any;

      await expect(handleGetCuratedProfileWaveDropsV2(req)).rejects.toThrow(
        '"page_size" must be less than or equal to 2000'
      );
      expect(mockFindCuratedProfileWaveDrops).not.toHaveBeenCalled();
    });
  });

  describe('handleGetDropsV2', () => {
    const result = { data: [], page: 1, next: false } as any;

    beforeEach(() => {
      mockFindDrops.mockResolvedValue(result);
    });

    it('applies query defaults before calling the service', async () => {
      const req = { query: {} } as any;

      await expect(handleGetDropsV2(req)).resolves.toBe(result);

      expect(mockGetFromRequest).toHaveBeenCalledWith(req);
      expect(mockGetAuthenticationContext).toHaveBeenCalledWith(req, timer);
      expect(mockFindDrops).toHaveBeenCalledWith(
        {
          parent_drop_id: null,
          page_size: 50,
          page: 1
        },
        {
          timer,
          authenticationContext
        }
      );
    });

    it('normalizes query params before calling the service', async () => {
      const req = {
        query: {
          parent_drop_id: '',
          page_size: '25',
          page: '2'
        }
      } as any;

      await handleGetDropsV2(req);

      expect(mockFindDrops).toHaveBeenCalledWith(
        {
          parent_drop_id: null,
          page_size: 25,
          page: 2
        },
        {
          timer,
          authenticationContext
        }
      );
    });

    it('rejects invalid query params', async () => {
      const req = { query: { page_size: '101' } } as any;

      await expect(handleGetDropsV2(req)).rejects.toThrow(
        '"page_size" must be less than or equal to 100'
      );
      expect(mockFindDrops).not.toHaveBeenCalled();
    });
  });

  describe('handleGetDropV2ById', () => {
    const result = { drop: { id: 'drop-1' }, wave: { id: 'wave-1' } } as any;

    beforeEach(() => {
      mockFindWithWaveByIdOrThrow.mockResolvedValue(result);
    });

    it('validates path params before calling the service', async () => {
      const req = { params: { id: 'drop-1' } } as any;

      await expect(handleGetDropV2ById(req)).resolves.toBe(result);

      expect(mockGetFromRequest).toHaveBeenCalledWith(req);
      expect(mockGetAuthenticationContext).toHaveBeenCalledWith(req, timer);
      expect(mockFindWithWaveByIdOrThrow).toHaveBeenCalledWith('drop-1', {
        timer,
        authenticationContext
      });
    });

    it('rejects invalid path params', async () => {
      const req = { params: {} } as any;

      await expect(handleGetDropV2ById(req)).rejects.toThrow(
        '"id" is required'
      );
      expect(mockFindWithWaveByIdOrThrow).not.toHaveBeenCalled();
    });
  });

  describe('handleGetDropV2MetadataById', () => {
    const result = [{ data_key: 'artist', data_value: '6529er' }] as any;

    beforeEach(() => {
      mockFindMetadataByDropIdOrThrow.mockResolvedValue(result);
    });

    it('validates path params before calling the service', async () => {
      const req = { params: { id: 'drop-1' } } as any;

      await expect(handleGetDropV2MetadataById(req)).resolves.toBe(result);

      expect(mockGetFromRequest).toHaveBeenCalledWith(req);
      expect(mockGetAuthenticationContext).toHaveBeenCalledWith(req, timer);
      expect(mockFindMetadataByDropIdOrThrow).toHaveBeenCalledWith('drop-1', {
        timer,
        authenticationContext
      });
    });

    it('rejects invalid path params', async () => {
      const req = { params: {} } as any;

      await expect(handleGetDropV2MetadataById(req)).rejects.toThrow(
        '"id" is required'
      );
      expect(mockFindMetadataByDropIdOrThrow).not.toHaveBeenCalled();
    });
  });

  describe('handleGetDropV2PartById', () => {
    const result = { part_no: 2, content: 'part content' } as any;

    beforeEach(() => {
      mockFindPartByDropIdOrThrow.mockResolvedValue(result);
    });

    it('validates path params before calling the service', async () => {
      const req = { params: { id: 'drop-1', part_no: '2' } } as any;

      await expect(handleGetDropV2PartById(req)).resolves.toBe(result);

      expect(mockGetFromRequest).toHaveBeenCalledWith(req);
      expect(mockGetAuthenticationContext).toHaveBeenCalledWith(req, timer);
      expect(mockFindPartByDropIdOrThrow).toHaveBeenCalledWith('drop-1', 2, {
        timer,
        authenticationContext
      });
    });

    it('rejects invalid path params', async () => {
      const req = { params: { id: 'drop-1', part_no: '0' } } as any;

      await expect(handleGetDropV2PartById(req)).rejects.toThrow(
        '"part_no" must be greater than or equal to 1'
      );
      expect(mockFindPartByDropIdOrThrow).not.toHaveBeenCalled();
    });
  });

  describe('handleGetDropV2BoostsById', () => {
    const result = [{ boosted_at: 123 }] as any;

    beforeEach(() => {
      mockFindBoostsByDropIdOrThrow.mockResolvedValue(result);
    });

    it('validates path params before calling the service', async () => {
      const req = { params: { id: 'drop-1' } } as any;

      await expect(handleGetDropV2BoostsById(req)).resolves.toBe(result);

      expect(mockGetFromRequest).toHaveBeenCalledWith(req);
      expect(mockGetAuthenticationContext).toHaveBeenCalledWith(req, timer);
      expect(mockFindBoostsByDropIdOrThrow).toHaveBeenCalledWith('drop-1', {
        timer,
        authenticationContext
      });
    });

    it('rejects invalid path params', async () => {
      const req = { params: {} } as any;

      await expect(handleGetDropV2BoostsById(req)).rejects.toThrow(
        '"id" is required'
      );
      expect(mockFindBoostsByDropIdOrThrow).not.toHaveBeenCalled();
    });
  });

  describe('handleGetDropV2ReactionsById', () => {
    const result = [{ reaction: 'fire', reactors: [] }] as any;

    beforeEach(() => {
      mockFindReactionsByDropIdOrThrow.mockResolvedValue(result);
    });

    it('validates path params before calling the service', async () => {
      const req = { params: { id: 'drop-1' } } as any;

      await expect(handleGetDropV2ReactionsById(req)).resolves.toBe(result);

      expect(mockGetFromRequest).toHaveBeenCalledWith(req);
      expect(mockGetAuthenticationContext).toHaveBeenCalledWith(req, timer);
      expect(mockFindReactionsByDropIdOrThrow).toHaveBeenCalledWith('drop-1', {
        timer,
        authenticationContext
      });
    });

    it('rejects invalid path params', async () => {
      const req = { params: {} } as any;

      await expect(handleGetDropV2ReactionsById(req)).rejects.toThrow(
        '"id" is required'
      );
      expect(mockFindReactionsByDropIdOrThrow).not.toHaveBeenCalled();
    });
  });

  describe('handleGetDropV2VotersById', () => {
    const result = { data: [], count: 0, page: 1, next: false } as any;

    beforeEach(() => {
      mockFindVotersByDropIdOrThrow.mockResolvedValue(result);
    });

    it('applies query defaults before calling the service', async () => {
      const req = { params: { id: 'drop-1' }, query: {} } as any;

      await expect(handleGetDropV2VotersById(req)).resolves.toBe(result);

      expect(mockGetFromRequest).toHaveBeenCalledWith(req);
      expect(mockGetAuthenticationContext).toHaveBeenCalledWith(req, timer);
      expect(mockFindVotersByDropIdOrThrow).toHaveBeenCalledWith(
        'drop-1',
        {
          page_size: 20,
          page: 1,
          sort_direction: PageSortDirection.DESC
        },
        {
          timer,
          authenticationContext
        }
      );
    });

    it('normalizes query params before calling the service', async () => {
      const req = {
        params: { id: 'drop-1' },
        query: {
          page_size: '50',
          page: '2',
          sort_direction: PageSortDirection.ASC
        }
      } as any;

      await handleGetDropV2VotersById(req);

      expect(mockFindVotersByDropIdOrThrow).toHaveBeenCalledWith(
        'drop-1',
        {
          page_size: 50,
          page: 2,
          sort_direction: PageSortDirection.ASC
        },
        {
          timer,
          authenticationContext
        }
      );
    });

    it('rejects invalid query params', async () => {
      const req = {
        params: { id: 'drop-1' },
        query: { page_size: '101' }
      } as any;

      await expect(handleGetDropV2VotersById(req)).rejects.toThrow(
        '"page_size" must be less than or equal to 100'
      );
      expect(mockFindVotersByDropIdOrThrow).not.toHaveBeenCalled();
    });
  });

  describe('handleDownloadDropV2VotersById', () => {
    const voters = [
      { handle: 'voter', level: 1, primary_address: '0x1' }
    ] as any;
    const res = { marker: 'response' } as any;

    beforeEach(() => {
      mockFindVotersCsvByDropIdOrThrow.mockResolvedValue(voters);
      mockReturnCSVResult.mockResolvedValue(res);
    });

    it('validates path params before returning csv', async () => {
      const req = { params: { id: 'drop-1' } } as any;

      await expect(handleDownloadDropV2VotersById(req, res)).resolves.toBe(
        undefined
      );

      expect(mockGetFromRequest).toHaveBeenCalledWith(req);
      expect(mockGetAuthenticationContext).toHaveBeenCalledWith(req, timer);
      expect(mockFindVotersCsvByDropIdOrThrow).toHaveBeenCalledWith('drop-1', {
        timer,
        authenticationContext
      });
      expect(mockReturnCSVResult).toHaveBeenCalledWith(
        'drop-drop-1-votes',
        voters,
        res
      );
    });

    it('rejects invalid path params', async () => {
      const req = { params: {} } as any;

      await expect(handleDownloadDropV2VotersById(req, res)).rejects.toThrow(
        '"id" is required'
      );
      expect(mockFindVotersCsvByDropIdOrThrow).not.toHaveBeenCalled();
      expect(mockReturnCSVResult).not.toHaveBeenCalled();
    });
  });

  describe('handleGetDropV2VoteEditLogsById', () => {
    const result = [{ id: 'log-1' }] as any;

    beforeEach(() => {
      mockFindVoteEditLogsByDropIdOrThrow.mockResolvedValue(result);
    });

    it('applies query defaults before calling the service', async () => {
      const req = { params: { id: 'drop-1' }, query: {} } as any;

      await expect(handleGetDropV2VoteEditLogsById(req)).resolves.toBe(result);

      expect(mockGetFromRequest).toHaveBeenCalledWith(req);
      expect(mockGetAuthenticationContext).toHaveBeenCalledWith(req, timer);
      expect(mockFindVoteEditLogsByDropIdOrThrow).toHaveBeenCalledWith(
        'drop-1',
        {
          offset: 0,
          limit: 20,
          sort_direction: PageSortDirection.DESC
        },
        {
          timer,
          authenticationContext
        }
      );
    });

    it('normalizes query params before calling the service', async () => {
      const req = {
        params: { id: 'drop-1' },
        query: {
          offset: '10',
          limit: '50',
          sort_direction: PageSortDirection.ASC
        }
      } as any;

      await handleGetDropV2VoteEditLogsById(req);

      expect(mockFindVoteEditLogsByDropIdOrThrow).toHaveBeenCalledWith(
        'drop-1',
        {
          offset: 10,
          limit: 50,
          sort_direction: PageSortDirection.ASC
        },
        {
          timer,
          authenticationContext
        }
      );
    });

    it('rejects invalid query params', async () => {
      const req = {
        params: { id: 'drop-1' },
        query: { limit: '101' }
      } as any;

      await expect(handleGetDropV2VoteEditLogsById(req)).rejects.toThrow(
        '"limit" must be less than or equal to 100'
      );
      expect(mockFindVoteEditLogsByDropIdOrThrow).not.toHaveBeenCalled();
    });
  });
});
