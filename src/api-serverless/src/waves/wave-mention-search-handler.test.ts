const mockGetAuthenticationContext = jest.fn();
const mockGetFromRequest = jest.fn();
const mockSearch = jest.fn();
const mockSearchDraft = jest.fn();

jest.mock('@/api/auth/auth', () => ({
  getAuthenticationContext: mockGetAuthenticationContext
}));

jest.mock('@/api/waves/wave-mention-search.api.service', () => ({
  waveMentionSearchApiService: {
    search: mockSearch,
    searchDraft: mockSearchDraft
  }
}));

jest.mock('@/time', () => ({
  Timer: { getFromRequest: mockGetFromRequest }
}));

import {
  handleSearchDraftWaveMentions,
  handleSearchWaveMentions
} from './wave-mention-search.handler';

describe('handleSearchWaveMentions', () => {
  const timer = { marker: 'timer' };
  const authenticationContext = { marker: 'authentication' };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetFromRequest.mockReturnValue(timer);
    mockGetAuthenticationContext.mockResolvedValue(authenticationContext);
    mockSearch.mockResolvedValue([]);
    mockSearchDraft.mockResolvedValue([]);
  });

  it('normalizes the handle and applies the default result limit', async () => {
    const req = {
      params: { waveId: 'wave-1' },
      query: { handle: '  ALI ' }
    } as any;

    await expect(handleSearchWaveMentions(req)).resolves.toEqual([]);

    expect(mockSearch).toHaveBeenCalledWith(
      { waveId: 'wave-1', handle: 'ali', limit: 5 },
      { authenticationContext, timer }
    );
  });

  it('accepts an explicit bounded result limit', async () => {
    const req = {
      params: { waveId: 'wave-1' },
      query: { handle: 'alice', limit: '10' }
    } as any;

    await handleSearchWaveMentions(req);

    expect(mockSearch).toHaveBeenCalledWith(
      { waveId: 'wave-1', handle: 'alice', limit: 10 },
      { authenticationContext, timer }
    );
  });

  it('rejects handles shorter than three characters', async () => {
    const req = {
      params: { waveId: 'wave-1' },
      query: { handle: 'al' }
    } as any;

    await expect(handleSearchWaveMentions(req)).rejects.toThrow();

    expect(mockSearch).not.toHaveBeenCalled();
  });

  it('searches a private draft using its selected visibility group', async () => {
    const req = {
      query: {
        handle: '  ALI ',
        visibility_group_id: 'visibility-group'
      }
    } as any;

    await expect(handleSearchDraftWaveMentions(req)).resolves.toEqual([]);

    expect(mockSearchDraft).toHaveBeenCalledWith(
      {
        visibilityGroupId: 'visibility-group',
        handle: 'ali',
        limit: 5
      },
      { authenticationContext, timer }
    );
  });

  it('searches a public draft without a visibility group', async () => {
    const req = {
      query: { handle: 'alice', limit: '10' }
    } as any;

    await handleSearchDraftWaveMentions(req);

    expect(mockSearchDraft).toHaveBeenCalledWith(
      { visibilityGroupId: null, handle: 'alice', limit: 10 },
      { authenticationContext, timer }
    );
  });
});
