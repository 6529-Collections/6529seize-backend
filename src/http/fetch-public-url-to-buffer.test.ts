jest.mock('@/http/public-fetch', () => {
  const actual = jest.requireActual('@/http/public-fetch');
  return { ...actual, publicFetch: jest.fn() };
});

import { publicFetch, PublicFetchTimeoutError } from '@/http/public-fetch';
import {
  fetchPublicUrlToBuffer,
  OVERALL_DEADLINE_TIMEOUT_MULTIPLIER
} from '@/http/safe-fetch';

const URL = 'https://example.com/image.png';

function okResult() {
  return {
    status: 200,
    ok: true,
    headers: new Headers({ 'content-type': 'image/png; charset=binary' }),
    body: Buffer.from('png'),
    finalUrl: URL
  };
}

describe('fetchPublicUrlToBuffer', () => {
  beforeEach(() => {
    jest.mocked(publicFetch).mockReset();
  });

  it('bounds each hop and the whole fetch including the body', async () => {
    jest.mocked(publicFetch).mockResolvedValue(okResult() as never);

    const result = await fetchPublicUrlToBuffer(URL, { timeoutMs: 1_000 });

    expect(publicFetch).toHaveBeenCalledWith(
      URL,
      expect.objectContaining({
        requestTimeoutMs: 1_000,
        timeoutMs: 1_000 * OVERALL_DEADLINE_TIMEOUT_MULTIPLIER
      })
    );
    expect(result).toEqual({
      buffer: Buffer.from('png'),
      contentType: 'image/png',
      finalUrl: URL
    });
  });

  it('derives the overall deadline from the default timeout', async () => {
    jest.mocked(publicFetch).mockResolvedValue(okResult() as never);

    await fetchPublicUrlToBuffer(URL);

    const options = jest.mocked(publicFetch).mock.calls[0][1];
    expect(options.timeoutMs).toBe(
      options.requestTimeoutMs! * OVERALL_DEADLINE_TIMEOUT_MULTIPLIER
    );
  });

  it('reports the overall deadline when it expires', async () => {
    jest
      .mocked(publicFetch)
      .mockRejectedValue(new PublicFetchTimeoutError(2_000));

    await expect(
      fetchPublicUrlToBuffer(URL, { timeoutMs: 1_000 })
    ).rejects.toThrow(`Fetch timed out after 2000ms: ${URL}`);
  });

  it('reports the per-hop timeout when a hop stalls', async () => {
    jest
      .mocked(publicFetch)
      .mockRejectedValue(
        Object.assign(new Error('aborted'), { name: 'AbortError' })
      );

    await expect(
      fetchPublicUrlToBuffer(URL, { timeoutMs: 1_000 })
    ).rejects.toThrow(`Fetch timed out after 1000ms: ${URL}`);
  });
});
