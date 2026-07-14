const mockFindByMemeCardId = jest.fn();
const mockGetFromRequest = jest.fn();

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
  });

  it('returns the Main Stage drop mapping for a Meme card', async () => {
    const mapping = { meme_card_id: 521, drop_id: 'drop-1' };
    mockFindByMemeCardId.mockResolvedValue(mapping);
    const req = { params: { meme_card_id: '521' } } as any;

    await expect(handleGetMemeCardDropMapping(req)).resolves.toBe(mapping);
    expect(mockGetFromRequest).toHaveBeenCalledWith(req);
    expect(mockFindByMemeCardId).toHaveBeenCalledWith(521, { timer });
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
});
