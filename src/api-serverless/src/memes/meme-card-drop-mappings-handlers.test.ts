const mockFindByMemeCardId = jest.fn();
const mockGetFromRequest = jest.fn();
const mockGetStringOrNull = jest.fn();

jest.mock('@/env', () => ({
  env: {
    getStringOrNull: mockGetStringOrNull
  }
}));

jest.mock('@/minting-claims/meme-card-drop-mappings.db', () => ({
  memeCardDropMappingsDb: {
    findByMemeCardId: mockFindByMemeCardId
  }
}));

jest.mock('@/time', () => ({
  Timer: {
    getFromRequest: mockGetFromRequest
  }
}));

import { NotFoundException } from '@/exceptions';
import { handleGetMemeCardDropMapping } from './meme-card-drop-mappings.handlers';

describe('handleGetMemeCardDropMapping', () => {
  const timer = { marker: 'timer' } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetFromRequest.mockReturnValue(timer);
    mockGetStringOrNull.mockReturnValue('main-stage-wave');
  });

  it('returns the Main Stage drop mapping for a Meme card', async () => {
    const mapping = {
      meme_card_id: 521,
      drop_id: 'drop-1',
      internal_only: 'not-public'
    };
    mockFindByMemeCardId.mockResolvedValue(mapping);
    const req = { params: { meme_card_id: '521' } } as any;

    await expect(handleGetMemeCardDropMapping(req)).resolves.toEqual({
      meme_card_id: 521,
      drop_id: 'drop-1'
    });
    expect(mockGetFromRequest).toHaveBeenCalledWith(req);
    expect(mockFindByMemeCardId).toHaveBeenCalledWith(521, 'main-stage-wave', {
      timer
    });
  });

  it.each(['0', '-1', 'not-a-number'])(
    'rejects invalid Meme card ID %s',
    async (memeCardId) => {
      await expect(
        handleGetMemeCardDropMapping({
          params: { meme_card_id: memeCardId }
        } as any)
      ).rejects.toThrow();
      expect(mockFindByMemeCardId).not.toHaveBeenCalled();
    }
  );

  it('returns not found when a Meme card has no Main Stage mapping', async () => {
    mockFindByMemeCardId.mockResolvedValue(null);

    await expect(
      handleGetMemeCardDropMapping({
        params: { meme_card_id: '1' }
      } as any)
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('returns not found when Main Stage is not configured', async () => {
    mockGetStringOrNull.mockReturnValue(null);

    await expect(
      handleGetMemeCardDropMapping({
        params: { meme_card_id: '521' }
      } as any)
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(mockFindByMemeCardId).not.toHaveBeenCalled();
  });
});
