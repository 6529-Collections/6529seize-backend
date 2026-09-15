import fetch, { Response } from 'node-fetch';
import { NftLinkResolver } from './nft-link-resolver';
import { ManifoldAdapter } from './adapters/manifold';
import { getAdapterFor } from './adapters/registry';
import { validateLinkUrl } from './nft-link-resolver.validator';
import { RequiredNftPageNotFoundError } from './nft-link-page-retry';
import { HttpError } from './lib/http';

jest.mock('node-fetch', () => ({
  ...jest.requireActual('node-fetch'),
  __esModule: true,
  default: jest.fn()
}));
jest.mock('./adapters/registry', () => ({ getAdapterFor: jest.fn() }));

const page = 'https://transient.xyz/mint/synthetic-fixture';
const manifold = 'https://app.manifold.xyz/c/synthetic-fixture';
const response = (status: number, url: string, body = '') =>
  new Response(body, { status, url });

describe('required page error provenance through real HTTP/resolver paths', () => {
  beforeEach(() => {
    jest.mocked(fetch).mockReset();
    jest.mocked(getAdapterFor).mockReturnValue(null);
  });

  it('types required Transient HTML 404 and resolves successfully on a later page recovery', async () => {
    jest.mocked(fetch).mockResolvedValueOnce(response(404, page));
    await expect(
      new NftLinkResolver().resolve(page, {})
    ).rejects.toBeInstanceOf(RequiredNftPageNotFoundError);
    jest
      .mocked(fetch)
      .mockResolvedValueOnce(
        response(
          200,
          page,
          '<meta property="og:title" content="Recovered"><meta property="og:image" content="https://example.com/recovered.png">'
        )
      );
    await expect(
      new NftLinkResolver().resolve(page, {})
    ).resolves.toMatchObject({
      asset: {
        title: 'Recovered',
        media: { imageUrl: 'https://example.com/recovered.png' }
      }
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not apply persistent page policy when only optional title enrichment fails', async () => {
    jest.mocked(getAdapterFor).mockReturnValue({
      canHandle: () => true,
      resolveFast: async () => ({
        patch: {
          asset: {
            media: {
              kind: 'image',
              imageUrl: 'https://example.com/cached.png'
            }
          }
        }
      })
    });
    jest.mocked(fetch).mockResolvedValue(response(404, page));
    await expect(
      new NftLinkResolver().resolve(page, {})
    ).rejects.toBeInstanceOf(HttpError);
  });

  it.each([429, 500, 503])(
    'preserves ordinary retries for HTTP %s',
    async (status) => {
      jest.mocked(fetch).mockResolvedValue(response(status, page));
      await expect(
        new NftLinkResolver().resolve(page, {})
      ).rejects.toMatchObject({ status });
    }
  );

  it('does not treat 200 HTML mentioning 404, a missing image, or a redirected 404 as canonical page 404', async () => {
    for (const result of [
      response(200, page, '404 not found'),
      response(404, page + '/moved')
    ]) {
      jest.mocked(fetch).mockResolvedValueOnce(result);
      await expect(
        new NftLinkResolver().resolve(page, {})
      ).rejects.not.toBeInstanceOf(RequiredNftPageNotFoundError);
    }
  });

  it('preserves an exact Manifold required slug-page 404 instead of losing its status', async () => {
    jest.mocked(fetch).mockResolvedValue(response(404, manifold));
    await expect(
      new ManifoldAdapter().resolveFast(validateLinkUrl(manifold))
    ).rejects.toBeInstanceOf(RequiredNftPageNotFoundError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not relabel an instance API 404 as a canonical page failure', async () => {
    jest
      .mocked(fetch)
      .mockImplementation(async (url) => response(404, String(url)));
    await expect(
      new ManifoldAdapter().resolveFast(
        validateLinkUrl(
          'https://app.manifold.xyz/c/synthetic-fixture?id=1234567'
        )
      )
    ).rejects.toThrow('Unable to fetch from');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
