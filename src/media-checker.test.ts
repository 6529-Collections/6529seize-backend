import { publicFetch } from '@/http/public-fetch';
import { MediaChecker } from '@/media-checker';

jest.mock('@/http/public-fetch', () => ({
  publicFetch: jest.fn()
}));

function headResponse(status: number, contentType: string | null) {
  return {
    status,
    ok: status >= 200 && status < 300,
    finalUrl: 'https://gateway.example/x',
    body: Buffer.alloc(0),
    headers: {
      get: (name: string) => (name === 'content-type' ? contentType : null)
    }
  } as unknown as Awaited<ReturnType<typeof publicFetch>>;
}

describe('MediaChecker', () => {
  const mockedFetch = jest.mocked(publicFetch);

  beforeEach(() => {
    mockedFetch.mockReset();
  });

  it('continues probing fallbacks when a response has no content type', async () => {
    mockedFetch
      .mockResolvedValueOnce(headResponse(200, null))
      .mockResolvedValueOnce(headResponse(200, 'image/png'));

    await expect(
      new MediaChecker().getContentType(
        'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
      )
    ).resolves.toBe('png');
    expect(mockedFetch).toHaveBeenCalledTimes(2);
    expect(mockedFetch).toHaveBeenCalledWith(expect.any(String), {
      method: 'HEAD',
      maxBytes: 0,
      maxRedirects: 5,
      timeoutMs: 5000
    });
  });

  it('skips error responses and transport refusals', async () => {
    mockedFetch
      .mockResolvedValueOnce(headResponse(404, 'text/html'))
      .mockRejectedValueOnce(new Error('Blocked host'))
      .mockResolvedValueOnce(headResponse(200, 'image/gif'));

    await expect(
      new MediaChecker().getContentType(
        'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
      )
    ).resolves.toBe('gif');
    expect(mockedFetch).toHaveBeenCalledTimes(3);
  });
});
