import fetch, { Response } from 'node-fetch';
import { ManifoldAdapter } from './manifold';
import { getAdapterFor } from './registry';
import { NftLinkResolver } from '../nft-link-resolver';
import { validateLinkUrl } from '../nft-link-resolver.validator';

jest.mock('node-fetch', () => ({
  ...jest.requireActual('node-fetch'),
  __esModule: true,
  default: jest.fn()
}));
jest.mock('./registry', () => ({ getAdapterFor: jest.fn() }));

const viewUrl = 'https://app.manifold.xyz/?id=1234567';
const canonical = validateLinkUrl(viewUrl);
const apiUrl =
  'https://apps.api.manifoldxyz.dev/public/instance/data?id=1234567';
const imageUrl = 'https://example.com/synthetic-token.png';
const token = {
  name: 'Synthetic selected token',
  description: 'Synthetic description',
  image: imageUrl
};

function serveInstance(data: unknown) {
  jest
    .mocked(fetch)
    .mockImplementation(async (url) =>
      String(url) === apiUrl
        ? new Response(JSON.stringify(data), { status: 200, url: apiUrl })
        : new Response('', { status: 404, url: String(url) })
    );
}

async function resolveInstance(data: unknown) {
  serveInstance(data);
  return new ManifoldAdapter().resolveFast(canonical);
}

describe('Manifold instance metadata through the real adapter and resolver', () => {
  beforeEach(() => {
    jest.mocked(fetch).mockReset();
    jest.mocked(getAdapterFor).mockReturnValue(new ManifoldAdapter());
  });

  it('resolves selected-token title and media without fetching a failing OG page', async () => {
    serveInstance({
      id: 1234567,
      name: 'Unverified root title must not replace the selected token',
      image: 'https://example.com/wrong-product.png',
      publicData: {
        selectedToken: token,
        listingType: 'synthetic-auction',
        mintPrice: {
          value: '1000000000000000000',
          currency: 'ETH',
          decimals: 18
        }
      }
    });
    const card = await new NftLinkResolver().resolve(viewUrl, {});
    expect(card.asset).toMatchObject({
      title: token.name,
      description: token.description,
      media: { kind: 'image', imageUrl }
    });
    expect(card.market).toEqual({
      saleType: 'UNKNOWN',
      cta: { label: 'View on Manifold', url: canonical.viewUrl }
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(jest.mocked(fetch).mock.calls[0][0]).toBe(apiUrl);
  });

  it.each([1234567, '1234567'])(
    'accepts an exactly matching primitive instance ID %s',
    async (id) => {
      const result = await resolveInstance({
        id,
        publicData: { selectedToken: token }
      });
      expect(result?.patch.asset?.title).toBe(token.name);
    }
  );

  it.each([1234567, 7654321])(
    'binds a slug-discovered ID to the instance response %s',
    async (id) => {
      const slugUrl = 'https://app.manifold.xyz/c/synthetic-claim';
      jest
        .mocked(fetch)
        .mockResolvedValueOnce(
          new Response(
            '<script type="application/json">{"instanceId":1234567}</script>',
            { status: 200, url: slugUrl }
          )
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              id,
              publicData: { selectedToken: token }
            }),
            { status: 200, url: apiUrl }
          )
        );
      const result = new ManifoldAdapter().resolveFast(
        validateLinkUrl(slugUrl)
      );
      if (id === 1234567) {
        await expect(result).resolves.toMatchObject({
          patch: { asset: { title: token.name } }
        });
      } else {
        await expect(result).rejects.toThrow(
          'Invalid Manifold instance response'
        );
      }
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(jest.mocked(fetch).mock.calls[1][0]).toBe(apiUrl);
    }
  );

  it.each([
    undefined,
    null,
    7654321,
    '7654321',
    true,
    {},
    [],
    1234567.5,
    Number.MAX_SAFE_INTEGER + 1,
    '01234567'
  ])(
    'rejects an unbound response ID %j before returning metadata',
    async (id) => {
      serveInstance({ id, publicData: { selectedToken: token } });
      await expect(new NftLinkResolver().resolve(viewUrl, {})).rejects.toThrow(
        'Invalid Manifold instance response'
      );
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  );

  it.each([null, [], 'invalid', 123])(
    'rejects a non-object response %j',
    async (data) => {
      await expect(resolveInstance(data)).rejects.toThrow(
        'Invalid Manifold instance response'
      );
    }
  );

  it.each([null, [], 'invalid', 123])(
    'rejects malformed selected-token objects %j',
    async (selectedToken) => {
      await expect(
        resolveInstance({
          id: 1234567,
          name: 'Must not use legacy claim',
          image: imageUrl,
          publicData: { selectedToken }
        })
      ).rejects.toThrow('Invalid Manifold selected token');
    }
  );

  it('does not coerce non-string metadata or read unverified token identities', async () => {
    const result = await resolveInstance({
      id: 1234567,
      publicData: {
        selectedToken: {
          name: { value: 'not a title' },
          description: 7,
          image: {},
          contractAddress: 'invalid',
          tokenId: {},
          spec: 'unsupported'
        }
      }
    });
    expect(result?.patch.asset).toEqual({
      title: undefined,
      description: undefined,
      media: undefined
    });
    expect(result?.patch.market?.saleType).toBe('UNKNOWN');
  });

  it('normalizes supported decentralized media through the existing resolver', async () => {
    const cid = 'QmYwAPJzv5CZsnAzt8auVTL6rQJ8K8Y1YwecqHHU1Q6iCk';
    const result = await resolveInstance({
      id: 1234567,
      publicData: {
        selectedToken: { ...token, image: `ipfs://${cid}/image.png` }
      }
    });
    expect(result?.patch.asset?.media?.imageUrl).toBe(
      `https://media.6529.io/ipfs/${cid}/image.png`
    );
  });

  it.each([
    'javascript:alert(1)',
    'data:image/png;base64,AAAA',
    'file:///tmp/a.png',
    '//example.com/a.png',
    'https://user:password@example.com/a.png',
    'not a url',
    '   '
  ])(
    'omits unsupported or credential-bearing selected-token media %s',
    async (image) => {
      const result = await resolveInstance({
        id: 1234567,
        publicData: { selectedToken: { ...token, image } }
      });
      expect(result?.patch.asset?.media).toBeUndefined();
    }
  );

  it('retains the existing OG fallback when selected-token media is absent', async () => {
    serveInstance({
      id: 1234567,
      publicData: { selectedToken: { name: token.name } }
    });
    jest
      .mocked(fetch)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 1234567,
            publicData: { selectedToken: { name: token.name } }
          }),
          { status: 200, url: apiUrl }
        )
      )
      .mockResolvedValueOnce(
        new Response(`<meta property="og:image" content="${imageUrl}">`, {
          status: 200,
          url: canonical.viewUrl
        })
      );
    const card = await new NftLinkResolver().resolve(viewUrl, {});
    expect(card.asset.media?.imageUrl).toBe(imageUrl);
    expect(card.market.saleType).toBe('UNKNOWN');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    { name: 'Listed token', image: imageUrl },
    { instance: { title: 'Listed token' }, image: imageUrl },
    { data: { title: 'Listed token', imageUrl } }
  ])(
    'retains legacy assets for a listingType-only response without an OG fetch',
    async (legacy) => {
      serveInstance({
        ...legacy,
        publicData: {
          listingType: 'future-product',
          mintPrice: { value: 'invalid', currency: {} }
        }
      });
      const card = await new NftLinkResolver().resolve(viewUrl, {});
      expect(card.asset).toMatchObject({
        title: 'Listed token',
        media: { kind: 'image', imageUrl }
      });
      expect(card.market).toEqual({
        saleType: 'UNKNOWN',
        cta: { label: 'View on Manifold', url: canonical.viewUrl }
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  );

  it.each([
    undefined,
    null,
    {},
    'not an instance id',
    Number.MAX_SAFE_INTEGER + 1
  ])(
    'preserves usable legacy metadata when its ID is missing or unrecognized: %j',
    async (id) => {
      const result = await resolveInstance({
        id,
        name: 'Legacy claim',
        image: imageUrl
      });
      expect(result?.patch.asset?.title).toBe('Legacy claim');
      expect(result?.patch.asset?.media?.imageUrl).toBe(imageUrl);
      expect(result?.patch.market?.saleType).toBe('CLAIM');
    }
  );

  it.each([7654321, '7654321'])(
    'rejects a known mismatching legacy response ID %s',
    async (id) => {
      await expect(
        resolveInstance({ id, name: 'Wrong instance', image: imageUrl })
      ).rejects.toThrow('Invalid Manifold instance response');
    }
  );

  it.each([
    {
      name: 'Legacy claim',
      image: imageUrl,
      description: 'Legacy',
      price: '150',
      currency: 'ETH',
      decimals: 2
    },
    {
      data: {
        title: 'Legacy claim',
        imageUrl,
        description: 'Legacy',
        mintPrice: '150',
        currencySymbol: 'ETH',
        decimals: 2
      }
    },
    {
      instance: { title: 'Legacy claim' },
      image: imageUrl,
      description: 'Legacy',
      publicData: { mintPrice: { value: '150', currency: 'ETH', decimals: 2 } }
    }
  ])(
    'preserves existing claim and edition metadata/price shapes',
    async (legacy) => {
      const result = await resolveInstance({ id: 1234567, ...legacy });
      expect(result?.patch.asset).toEqual({
        title: 'Legacy claim',
        description: 'Legacy',
        media: { kind: 'image', imageUrl }
      });
      expect(result?.patch.market).toEqual({
        saleType: 'CLAIM',
        price: { amount: '1.5', currency: 'ETH' },
        cta: { label: 'Claim', url: canonical.viewUrl }
      });
    }
  );
});
