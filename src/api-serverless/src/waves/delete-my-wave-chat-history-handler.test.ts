const mockDeleteMyWaveChatHistory = jest.fn();
const mockGetAuthenticationContext = jest.fn();
const mockGetFromRequest = jest.fn();

jest.mock('@/api/auth/auth', () => ({
  getAuthenticationContext: mockGetAuthenticationContext
}));

jest.mock('@/api/drops/drop-creation.api.service', () => ({
  dropCreationService: {
    deleteMyWaveChatHistory: mockDeleteMyWaveChatHistory
  }
}));

jest.mock('@/time', () => ({
  Timer: {
    getFromRequest: mockGetFromRequest
  }
}));

import { handleDeleteMyWaveChatHistory } from './delete-my-wave-chat-history.handler';

describe('handleDeleteMyWaveChatHistory', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('validates the wave id and forwards authenticated context', async () => {
    const timer = { marker: 'timer' };
    const authenticationContext = { marker: 'auth' };
    const response = {
      deleted_drop_ids: ['drop-1'],
      preserved_pinned_drop_id: 'drop-pinned'
    };
    const req = { params: { id: 'wave-1' } } as any;
    mockGetFromRequest.mockReturnValue(timer);
    mockGetAuthenticationContext.mockResolvedValue(authenticationContext);
    mockDeleteMyWaveChatHistory.mockResolvedValue(response);

    await expect(handleDeleteMyWaveChatHistory(req)).resolves.toBe(response);

    expect(mockGetFromRequest).toHaveBeenCalledWith(req);
    expect(mockGetAuthenticationContext).toHaveBeenCalledWith(req, timer);
    expect(mockDeleteMyWaveChatHistory).toHaveBeenCalledWith(
      { waveId: 'wave-1' },
      { authenticationContext, timer }
    );
  });

  it('rejects a missing wave id before calling the service', async () => {
    await expect(
      handleDeleteMyWaveChatHistory({ params: {} } as any)
    ).rejects.toThrow('"id" is required');

    expect(mockDeleteMyWaveChatHistory).not.toHaveBeenCalled();
  });
});
