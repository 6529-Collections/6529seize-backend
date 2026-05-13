const mockFindDropsFeed = jest.fn();
const mockGetAuthenticationContext = jest.fn();
const mockGetFromRequest = jest.fn();

jest.mock('@/api/auth/auth', () => ({
  getAuthenticationContext: mockGetAuthenticationContext
}));

jest.mock('@/api/waves/api-wave-v2.service', () => ({
  apiWaveV2Service: {
    findDropsFeed: mockFindDropsFeed
  }
}));

jest.mock('@/time', () => ({
  Timer: {
    getFromRequest: mockGetFromRequest
  }
}));

import { ApiDropSearchStrategy } from '@/api/generated/models/ApiDropSearchStrategy';
import { ApiDropType } from '@/api/generated/models/ApiDropType';
import { handleGetWaveDropsV2 } from './get-wave-drops-v2.handler';

describe('handleGetWaveDropsV2', () => {
  const timer = { marker: 'timer' } as any;
  const authenticationContext = { marker: 'auth' } as any;
  const result = { drops: [], latest_serial_no: 1 } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFindDropsFeed.mockResolvedValue(result);
    mockGetAuthenticationContext.mockResolvedValue(authenticationContext);
    mockGetFromRequest.mockReturnValue(timer);
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

    await expect(handleGetWaveDropsV2(req)).rejects.toThrow('"id" is required');
    expect(mockFindDropsFeed).not.toHaveBeenCalled();
  });
});
