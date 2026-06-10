import axios from 'axios';
import { MediaChecker } from '@/media-checker';

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    head: jest.fn()
  }
}));

describe('MediaChecker', () => {
  const mockedHead = jest.mocked(axios.head);

  beforeEach(() => {
    mockedHead.mockReset();
  });

  it('continues probing fallbacks when a response has no content type', async () => {
    mockedHead
      .mockResolvedValueOnce({ headers: {} })
      .mockResolvedValueOnce({ headers: { 'content-type': 'image/png' } });

    await expect(
      new MediaChecker().getContentType(
        'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
      )
    ).resolves.toBe('png');
    expect(mockedHead).toHaveBeenCalledTimes(2);
  });
});
