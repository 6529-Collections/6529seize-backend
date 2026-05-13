const mockSearchDropsContainingPhraseInWave = jest.fn();
const mockGetAuthenticationContext = jest.fn();
const mockGetFromRequest = jest.fn();

jest.mock('@/api/auth/auth', () => ({
  getAuthenticationContext: mockGetAuthenticationContext
}));

jest.mock('@/api/waves/api-wave-v2.service', () => ({
  apiWaveV2Service: {
    searchDropsContainingPhraseInWave: mockSearchDropsContainingPhraseInWave
  }
}));

jest.mock('@/time', () => ({
  Timer: {
    getFromRequest: mockGetFromRequest
  }
}));

import { handleSearchDropsInWaveV2 } from './search-drops-in-wave-v2.handler';

describe('handleSearchDropsInWaveV2', () => {
  const timer = { marker: 'timer' } as any;
  const authenticationContext = { marker: 'auth' } as any;
  const result = { data: [], page: 1, next: false } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSearchDropsContainingPhraseInWave.mockResolvedValue(result);
    mockGetAuthenticationContext.mockResolvedValue(authenticationContext);
    mockGetFromRequest.mockReturnValue(timer);
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
